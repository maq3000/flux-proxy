use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use dashmap::DashMap;

#[derive(Debug, Clone)]
pub struct ClientProcessInfo {
    pub pid: u32,
    pub name: String,
}

const PID_CACHE_TTL: Duration = Duration::from_secs(30);

fn pid_name_cache() -> &'static DashMap<u32, (String, Instant)> {
    static CACHE: OnceLock<DashMap<u32, (String, Instant)>> = OnceLock::new();
    CACHE.get_or_init(DashMap::new)
}

/// Resolves an accepted loopback/local client TCP socket (`127.0.0.1:ephemeral_port` or `[::1]:port`)
/// to its owning OS Process ID (PID) and executable name (`chrome.exe`, `node.exe`, `python`, `Postman`, etc.).
pub fn resolve_client_process(
    client_addr: SocketAddr,
    proxy_port: Option<u16>,
) -> Option<ClientProcessInfo> {
    // Only local / loopback client sockets exist in the local OS TCP table
    if !client_addr.ip().is_loopback() && !is_local_interface_ip(&client_addr) {
        return None;
    }

    let pid = lookup_owning_pid(client_addr, proxy_port)?;
    let name = resolve_process_name_cached(pid)
        .unwrap_or_else(|| format!("pid-{pid}"));

    Some(ClientProcessInfo { pid, name })
}

fn is_local_interface_ip(addr: &SocketAddr) -> bool {
    crate::proxy::network::is_host_own_ip(addr.ip())
}

fn resolve_process_name_cached(pid: u32) -> Option<String> {
    let cache = pid_name_cache();
    if let Some(entry) = cache.get(&pid) {
        if entry.1.elapsed() < PID_CACHE_TTL {
            return Some(entry.0.clone());
        }
    }

    let resolved = query_os_process_name(pid)?;
    cache.insert(pid, (resolved.clone(), Instant::now()));
    Some(resolved)
}

// ============================================================================
// Windows Implementation (`GetExtendedTcpTable` + `QueryFullProcessImageNameW`)
// ============================================================================
#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use std::ffi::c_void;
    use std::net::Ipv6Addr;

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const TCP_TABLE_OWNER_PID_CONNECTIONS: i32 = 4;
    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcpRowOwnerPid {
        dw_state: u32,
        dw_local_addr: u32,
        dw_local_port: u32,
        dw_remote_addr: u32,
        dw_remote_port: u32,
        dw_owning_pid: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibTcp6RowOwnerPid {
        uc_local_addr: [u8; 16],
        dw_local_scope_id: u32,
        dw_local_port: u32,
        uc_remote_addr: [u8; 16],
        dw_remote_scope_id: u32,
        dw_remote_port: u32,
        dw_owning_pid: u32,
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            p_tcp_table: *mut u8,
            pdw_size: *mut u32,
            b_order: i32,
            ul_af: u32,
            table_class: i32,
            reserved: u32,
        ) -> u32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(
            dw_desired_access: u32,
            b_inherit_handle: i32,
            dw_process_id: u32,
        ) -> *mut c_void;

        fn QueryFullProcessImageNameW(
            h_process: *mut c_void,
            dw_flags: u32,
            lp_exe_name: *mut u16,
            lpdw_size: *mut u32,
        ) -> i32;

        fn CloseHandle(h_object: *mut c_void) -> i32;
    }

    fn fetch_tcp_table_raw(af: u32) -> Option<Vec<u8>> {
        let mut size: u32 = 0;
        // Initial probe to obtain required byte buffer size
        let first = unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                af,
                TCP_TABLE_OWNER_PID_CONNECTIONS,
                0,
            )
        };
        if first != ERROR_INSUFFICIENT_BUFFER && first != NO_ERROR {
            return None;
        }

        // Retry up to 3 times if concurrent socket churn grows the table mid-call
        for _ in 0..3 {
            let alloc_len = (size as usize).saturating_add(512);
            let mut buf = vec![0u8; alloc_len];
            let mut actual_size = alloc_len as u32;
            let status = unsafe {
                GetExtendedTcpTable(
                    buf.as_mut_ptr(),
                    &mut actual_size,
                    0,
                    af,
                    TCP_TABLE_OWNER_PID_CONNECTIONS,
                    0,
                )
            };
            if status == NO_ERROR {
                buf.truncate(actual_size as usize);
                return Some(buf);
            }
            if status == ERROR_INSUFFICIENT_BUFFER {
                size = actual_size;
                continue;
            }
            return None;
        }
        None
    }

    fn find_ipv4_pid(target_ip: Ipv4Addr, target_port: u16, proxy_port: Option<u16>) -> Option<u32> {
        let buf = fetch_tcp_table_raw(AF_INET)?;
        if buf.len() < 4 {
            return None;
        }
        let num_entries = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let row_size = std::mem::size_of::<MibTcpRowOwnerPid>();
        let max_rows = (buf.len() - 4) / row_size;
        let count = num_entries.min(max_rows);

        let mut fallback_pid: Option<u32> = None;
        let rows_ptr = unsafe { buf.as_ptr().add(4) as *const MibTcpRowOwnerPid };

        for i in 0..count {
            let row = unsafe { std::ptr::read_unaligned(rows_ptr.add(i)) };
            if row.dw_owning_pid == 0 {
                continue;
            }
            let local_port = u16::from_be((row.dw_local_port & 0xFFFF) as u16);
            if local_port != target_port {
                continue;
            }
            let local_ip = Ipv4Addr::from(row.dw_local_addr.to_ne_bytes());
            if local_ip != target_ip && !local_ip.is_unspecified() {
                continue;
            }
            let remote_port = u16::from_be((row.dw_remote_port & 0xFFFF) as u16);
            if let Some(expected_proxy_port) = proxy_port {
                if remote_port == expected_proxy_port {
                    return Some(row.dw_owning_pid);
                }
            }
            fallback_pid = Some(row.dw_owning_pid);
        }

        fallback_pid
    }

    fn find_ipv6_pid(target_ip: Ipv6Addr, target_port: u16, proxy_port: Option<u16>) -> Option<u32> {
        let buf = fetch_tcp_table_raw(AF_INET6)?;
        if buf.len() < 4 {
            return None;
        }
        let num_entries = u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let row_size = std::mem::size_of::<MibTcp6RowOwnerPid>();
        let max_rows = (buf.len() - 4) / row_size;
        let count = num_entries.min(max_rows);

        let mut fallback_pid: Option<u32> = None;
        let rows_ptr = unsafe { buf.as_ptr().add(4) as *const MibTcp6RowOwnerPid };
        let target_octets = target_ip.octets();

        for i in 0..count {
            let row = unsafe { std::ptr::read_unaligned(rows_ptr.add(i)) };
            if row.dw_owning_pid == 0 {
                continue;
            }
            let local_port = u16::from_be((row.dw_local_port & 0xFFFF) as u16);
            if local_port != target_port {
                continue;
            }
            let local_addr = Ipv6Addr::from(row.uc_local_addr);
            if row.uc_local_addr != target_octets && !local_addr.is_unspecified() {
                continue;
            }
            let remote_port = u16::from_be((row.dw_remote_port & 0xFFFF) as u16);
            if let Some(expected_proxy_port) = proxy_port {
                if remote_port == expected_proxy_port {
                    return Some(row.dw_owning_pid);
                }
            }
            fallback_pid = Some(row.dw_owning_pid);
        }

        fallback_pid
    }

    pub fn lookup_owning_pid(client_addr: SocketAddr, proxy_port: Option<u16>) -> Option<u32> {
        match client_addr {
            SocketAddr::V4(v4) => find_ipv4_pid(*v4.ip(), v4.port(), proxy_port),
            SocketAddr::V6(v6) => {
                if let Some(mapped_v4) = v6.ip().to_ipv4_mapped() {
                    if let Some(pid) = find_ipv4_pid(mapped_v4, v6.port(), proxy_port) {
                        return Some(pid);
                    }
                }
                find_ipv6_pid(*v6.ip(), v6.port(), proxy_port)
            }
        }
    }

    pub fn query_os_process_name(pid: u32) -> Option<String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }

        let mut wide_buf = [0u16; 1024];
        let mut len = wide_buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(handle, 0, wide_buf.as_mut_ptr(), &mut len)
        };
        unsafe {
            CloseHandle(handle);
        }

        if ok == 0 || len == 0 {
            return None;
        }

        let full_path = String::from_utf16_lossy(&wide_buf[..len as usize]);
        Path::new(&full_path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
    }
}

// ============================================================================
// Linux Implementation (`/proc/net/tcp` + `/proc/<pid>/fd`)
// ============================================================================
#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use std::fs;

    fn find_socket_inode_in_proc_table(
        proc_file: &str,
        target_port: u16,
        proxy_port: Option<u16>,
    ) -> Option<String> {
        let content = fs::read_to_string(proc_file).ok()?;
        let port_hex = format!("{target_port:04X}");
        let remote_hex = proxy_port.map(|p| format!("{p:04X}"));
        let mut fallback_inode: Option<String> = None;

        for line in content.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 {
                continue;
            }
            let local_col = cols[1];
            let remote_col = cols[2];
            let inode = cols[9];
            if inode == "0" {
                continue;
            }
            if let Some((_, lport)) = local_col.split_once(':') {
                if lport.eq_ignore_ascii_case(&port_hex) {
                    if let Some(ref expected_rport) = remote_hex {
                        if let Some((_, rport)) = remote_col.split_once(':') {
                            if rport.eq_ignore_ascii_case(expected_rport) {
                                return Some(inode.to_string());
                            }
                        }
                    }
                    fallback_inode = Some(inode.to_string());
                }
            }
        }
        fallback_inode
    }

    pub fn lookup_owning_pid(client_addr: SocketAddr, proxy_port: Option<u16>) -> Option<u32> {
        let port = client_addr.port();
        let inode = match client_addr {
            SocketAddr::V4(_) => find_socket_inode_in_proc_table("/proc/net/tcp", port, proxy_port)
                .or_else(|| find_socket_inode_in_proc_table("/proc/net/tcp6", port, proxy_port)),
            SocketAddr::V6(_) => find_socket_inode_in_proc_table("/proc/net/tcp6", port, proxy_port)
                .or_else(|| find_socket_inode_in_proc_table("/proc/net/tcp", port, proxy_port)),
        }?;

        let target_link = format!("socket:[{inode}]");
        let proc_entries = fs::read_dir("/proc").ok()?;
        for entry in proc_entries.flatten() {
            let file_name = entry.file_name();
            let Some(pid_str) = file_name.to_str() else {
                continue;
            };
            let Ok(pid) = pid_str.parse::<u32>() else {
                continue;
            };
            let fd_dir = entry.path().join("fd");
            let Ok(fds) = fs::read_dir(fd_dir) else {
                continue;
            };
            for fd in fds.flatten() {
                if let Ok(link) = fs::read_link(fd.path()) {
                    if link.to_string_lossy() == target_link {
                        return Some(pid);
                    }
                }
            }
        }
        None
    }

    pub fn query_os_process_name(pid: u32) -> Option<String> {
        if let Ok(exe) = fs::read_link(format!("/proc/{pid}/exe")) {
            if let Some(name) = exe.file_name() {
                return Some(name.to_string_lossy().into_owned());
            }
        }
        fs::read_to_string(format!("/proc/{pid}/comm"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

// ============================================================================
// macOS Implementation (`libproc` `proc_listpids` + `proc_name`)
// ============================================================================
#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use std::ffi::c_void;

    const PROC_ALL_PIDS: u32 = 1;
    const PROC_PIDLISTFDS: i32 = 1;
    const PROX_FDTYPE_SOCKET: u32 = 2;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct ProcFdInfo {
        proc_fd: i32,
        proc_fdtype: u32,
    }

    extern "C" {
        fn proc_listpids(
            kind: u32,
            typeinfo: u32,
            buffer: *mut c_void,
            buffersize: i32,
        ) -> i32;
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut c_void,
            buffersize: i32,
        ) -> i32;
        fn proc_name(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
    }

    pub fn lookup_owning_pid(client_addr: SocketAddr, _proxy_port: Option<u16>) -> Option<u32> {
        // Use lsof fast port lookup or libproc fallback on macOS
        let port = client_addr.port();
        let output = std::process::Command::new("lsof")
            .args(["-n", "-P", "-F", "p", "-i", &format!("TCP:{port}")])
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let self_pid = std::process::id();
        let mut candidate: Option<u32> = None;

        // Suppress unused warnings on FFI symbols kept ready for proc_name
        let _ = (PROC_ALL_PIDS, PROC_PIDLISTFDS, PROX_FDTYPE_SOCKET, proc_listpids as usize, proc_pidinfo as usize);

        for line in stdout.lines() {
            if let Some(rest) = line.strip_prefix('p') {
                if let Ok(pid) = rest.trim().parse::<u32>() {
                    if pid != self_pid {
                        return Some(pid);
                    }
                    candidate = Some(pid);
                }
            }
        }
        let _ = ProcFdInfo::default();
        candidate
    }

    pub fn query_os_process_name(pid: u32) -> Option<String> {
        let mut buf = [0u8; 256];
        let len = unsafe { proc_name(pid as i32, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
        if len <= 0 {
            return None;
        }
        let name = String::from_utf8_lossy(&buf[..len as usize]).trim_matches('\0').to_string();
        if name.is_empty() { None } else { Some(name) }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
mod imp {
    use super::*;
    pub fn lookup_owning_pid(_client_addr: SocketAddr, _proxy_port: Option<u16>) -> Option<u32> {
        None
    }
    pub fn query_os_process_name(_pid: u32) -> Option<String> {
        None
    }
}

use imp::{lookup_owning_pid, query_os_process_name};

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn resolves_live_loopback_tcp_socket_to_current_process() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback listener");
        let server_addr = listener.local_addr().expect("listener local_addr");

        let client = TcpStream::connect(server_addr).expect("connect loopback client");
        let (_accepted, peer_addr) = listener.accept().expect("accept loopback client");
        assert_eq!(client.local_addr().unwrap(), peer_addr);

        let resolved = resolve_client_process(peer_addr, Some(server_addr.port()))
            .expect("should resolve active loopback socket to owning PID");

        assert_eq!(resolved.pid, std::process::id());
        assert!(!resolved.name.is_empty());
    }
}
