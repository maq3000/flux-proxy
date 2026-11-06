use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

use crate::models::NetworkInterfaceInfo;

const HOST_IPS_CACHE_TTL: Duration = Duration::from_secs(8);

struct HostIpCache {
    updated_at: Instant,
    ipv4s: HashSet<Ipv4Addr>,
}

fn host_ip_cache() -> &'static RwLock<Option<HostIpCache>> {
    static CACHE: OnceLock<RwLock<Option<HostIpCache>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

/// Normalizes a `SocketAddr` into a clean display IP string (unwrapping IPv4-mapped IPv6 `::ffff:a.b.c.d`).
pub fn normalize_client_ip(addr: SocketAddr) -> String {
    match addr.ip() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6.to_string(),
        },
    }
}

/// Returns `true` if `ip` belongs to THIS machine (loopback or any local network interface on this host).
/// Used to distinguish local OS client processes from remote mobile / LAN devices.
pub fn is_host_own_ip(ip: IpAddr) -> bool {
    let v4 = match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                return true;
            }
            v4
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                return true;
            }
            match v6.to_ipv4_mapped() {
                Some(mapped) if mapped.is_loopback() => return true,
                Some(mapped) => mapped,
                None => return false,
            }
        }
    };

    if let Ok(guard) = host_ip_cache().read() {
        if let Some(cached) = guard.as_ref() {
            if cached.updated_at.elapsed() < HOST_IPS_CACHE_TTL {
                return cached.ipv4s.contains(&v4);
            }
        }
    }

    let fresh = collect_all_host_ipv4s();
    let hit = fresh.contains(&v4);
    if let Ok(mut guard) = host_ip_cache().write() {
        *guard = Some(HostIpCache {
            updated_at: Instant::now(),
            ipv4s: fresh,
        });
    }
    hit
}

/// Probes the OS routing table (without transmitting any network packets) to determine
/// the primary outbound LAN IPv4 address used to reach external networks.
pub fn detect_primary_outbound_ipv4() -> Option<Ipv4Addr> {
    for target in ["8.8.8.8:80", "1.1.1.1:80", "192.168.1.1:80", "10.0.0.1:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(SocketAddr::V4(local)) = sock.local_addr() {
                    let ip = *local.ip();
                    if is_usable_lan_ipv4(ip) {
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

/// Returns active local LAN IPv4 network interfaces (Wi-Fi, Ethernet), excluding loopback (`127.0.0.1`),
/// link-local (`169.254.x.x`), CGNAT/VPN (`100.64.0.0/10`), and virtual adapters (WSL, Hyper-V, Docker, VMware, VirtualBox, etc.).
pub fn list_network_interfaces() -> Vec<NetworkInterfaceInfo> {
    let primary_ip = detect_primary_outbound_ipv4();
    let mut list = query_active_lan_interfaces(primary_ip);

    // Ensure primary outbound LAN IP is always present even if an unusual OS driver hid its adapter metadata
    if let Some(primary) = primary_ip {
        let primary_str = primary.to_string();
        if !list.iter().any(|item| item.ip == primary_str) && !is_cgnat_or_vpn_ipv4(primary) {
            list.push(NetworkInterfaceInfo {
                name: "Primary Network".to_string(),
                ip: primary_str,
                kind: "wifi".to_string(),
                is_primary: true,
            });
        }
    }

    // Sort: primary interface first, then Wi-Fi, then Ethernet, then alphabetical
    list.sort_by(|a, b| {
        b.is_primary
            .cmp(&a.is_primary)
            .then_with(|| kind_priority(&a.kind).cmp(&kind_priority(&b.kind)))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.ip.cmp(&b.ip))
    });

    // If none was marked primary yet (e.g. isolated offline Wi-Fi router without default WAN gateway),
    // promote the top Wi-Fi/Ethernet interface as primary for convenience.
    if !list.is_empty() && !list.iter().any(|i| i.is_primary) {
        list[0].is_primary = true;
    }

    list
}

fn kind_priority(kind: &str) -> u8 {
    match kind {
        "wifi" => 0,
        "ethernet" => 1,
        _ => 2,
    }
}

pub(crate) fn is_usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_unspecified()
        && !ip.is_link_local()
        && !ip.is_broadcast()
        && !ip.is_multicast()
}

pub(crate) fn is_cgnat_or_vpn_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    // RFC 6598 100.64.0.0/10 (commonly used by Tailscale / Carrier-Grade NAT)
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

pub(crate) fn is_virtual_or_excluded_adapter(name: &str, description: &str) -> bool {
    let combined = format!(
        "{} {}",
        name.trim().to_ascii_lowercase(),
        description.trim().to_ascii_lowercase()
    );

    const VIRTUAL_KEYWORDS: &[&str] = &[
        "vethernet",
        "wsl",
        "hyper-v",
        "docker",
        "podman",
        "vbox",
        "virtualbox",
        "vmware",
        "vmnet",
        "virbr",
        "veth",
        "br-",
        "tailscale",
        "wireguard",
        "wintun",
        "zerotier",
        "hamachi",
        "radmin",
        "openvpn",
        "anyconnect",
        "fortissl",
        "pangp",
        "tap-windows",
        "tap adapter",
        "tun",
        "utun",
        "awdl",
        "llw",
        "gif",
        "stf",
        "loopback",
        "teredo",
        "isatap",
        "6to4",
        "bluetooth",
        "npcap",
        "wan miniport",
        "wi-fi direct virtual",
        "hosted network virtual",
        "virtual adapter",
        "pseudo-interface",
    ];

    VIRTUAL_KEYWORDS.iter().any(|kw| combined.contains(kw))
}

pub(crate) fn classify_interface_kind(name: &str, description: &str) -> &'static str {
    let combined = format!(
        "{} {}",
        name.to_ascii_lowercase(),
        description.to_ascii_lowercase()
    );
    if combined.contains("wi-fi")
        || combined.contains("wifi")
        || combined.contains("wlan")
        || combined.contains("wireless")
        || combined.contains("802.11")
        || combined.contains("airport")
        || combined.contains("беспровод")
    {
        "wifi"
    } else if combined.contains("ethernet")
        || combined.contains("eth")
        || combined.contains("en0")
        || combined.contains("en1")
        || combined.contains("enp")
        || combined.contains("eno")
        || combined.contains("realtek")
        || combined.contains("intel(r) ethernet")
        || combined.contains("gigabit")
    {
        "ethernet"
    } else {
        "other"
    }
}

// ============================================================================
// Windows Implementation (`iphlpapi`: `GetIpAddrTable`, `GetIfEntry`, `ConvertInterfaceIndexToLuid`)
// ============================================================================
#[cfg(target_os = "windows")]
fn collect_all_host_ipv4s() -> HashSet<Ipv4Addr> {
    win_imp::get_raw_ipv4_rows()
        .into_iter()
        .map(|(ip, _)| ip)
        .collect()
}

#[cfg(target_os = "windows")]
fn query_active_lan_interfaces(primary_ip: Option<Ipv4Addr>) -> Vec<NetworkInterfaceInfo> {
    win_imp::query_interfaces(primary_ip)
}

#[cfg(target_os = "windows")]
mod win_imp {
    use super::*;

    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const MAX_INTERFACE_NAME_LEN: usize = 256;
    const MAXLEN_PHYSADDR: usize = 8;
    const MAXLEN_IFDESCR: usize = 256;
    const NDIS_IF_MAX_STRING_SIZE: usize = 256;

    const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
    const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
    const IF_TYPE_PPP: u32 = 23;
    const IF_TYPE_PROP_VIRTUAL: u32 = 53;
    const IF_TYPE_IEEE80211: u32 = 71;
    const IF_TYPE_TUNNEL: u32 = 131;

    const IF_OPER_STATUS_CONNECTED: u32 = 4;
    const IF_OPER_STATUS_OPERATIONAL: u32 = 5;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MibIpAddrRow {
        dw_addr: u32,
        dw_index: u32,
        dw_mask: u32,
        dw_bcast_addr: u32,
        dw_reasm_size: u32,
        unused1: u16,
        w_type: u16,
    }

    #[repr(C)]
    struct MibIfRow {
        wsz_name: [u16; MAX_INTERFACE_NAME_LEN],
        dw_index: u32,
        dw_type: u32,
        dw_mtu: u32,
        dw_speed: u32,
        dw_phys_addr_len: u32,
        b_phys_addr: [u8; MAXLEN_PHYSADDR],
        dw_admin_status: u32,
        dw_oper_status: u32,
        dw_last_change: u32,
        dw_in_octets: u32,
        dw_in_ucast_pkts: u32,
        dw_in_nucast_pkts: u32,
        dw_in_discards: u32,
        dw_in_errors: u32,
        dw_in_unknown_protos: u32,
        dw_out_octets: u32,
        dw_out_ucast_pkts: u32,
        dw_out_nucast_pkts: u32,
        dw_out_discards: u32,
        dw_out_errors: u32,
        dw_out_qlen: u32,
        dw_descr_len: u32,
        b_descr: [u8; MAXLEN_IFDESCR],
    }

    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetIpAddrTable(
            p_ip_addr_table: *mut u8,
            pdw_size: *mut u32,
            b_order: i32,
        ) -> u32;
        fn GetIfEntry(p_if_row: *mut MibIfRow) -> u32;
        fn ConvertInterfaceIndexToLuid(interface_index: u32, interface_luid: *mut u64) -> u32;
        fn ConvertInterfaceLuidToAlias(
            interface_luid: *const u64,
            interface_alias: *mut u16,
            length: usize,
        ) -> u32;
    }

    pub fn get_raw_ipv4_rows() -> Vec<(Ipv4Addr, u32)> {
        let mut size: u32 = 0;
        let rc = unsafe { GetIpAddrTable(std::ptr::null_mut(), &mut size, 0) };
        if rc != ERROR_INSUFFICIENT_BUFFER || size == 0 {
            return Vec::new();
        }

        let mut buf = vec![0u8; (size as usize) + 256];
        let mut actual_size = buf.len() as u32;
        let rc = unsafe { GetIpAddrTable(buf.as_mut_ptr(), &mut actual_size, 0) };
        if rc != NO_ERROR || actual_size < 4 {
            return Vec::new();
        }

        let num_entries =
            u32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        let row_size = std::mem::size_of::<MibIpAddrRow>();
        let max_rows = buf.len().saturating_sub(4) / row_size;
        let count = num_entries.min(max_rows);
        let rows_ptr = unsafe { buf.as_ptr().add(4) as *const MibIpAddrRow };

        let mut out = Vec::with_capacity(count);
        for i in 0..count {
            let row = unsafe { *rows_ptr.add(i) };
            let ip = Ipv4Addr::from(u32::from_be(row.dw_addr));
            out.push((ip, row.dw_index));
        }
        out
    }

    fn resolve_interface_alias(if_index: u32) -> Option<String> {
        let mut luid: u64 = 0;
        if unsafe { ConvertInterfaceIndexToLuid(if_index, &mut luid) } != NO_ERROR {
            return None;
        }
        let mut alias_buf = [0u16; NDIS_IF_MAX_STRING_SIZE + 1];
        if unsafe {
            ConvertInterfaceLuidToAlias(&luid, alias_buf.as_mut_ptr(), alias_buf.len())
        } != NO_ERROR
        {
            return None;
        }
        let end = alias_buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(alias_buf.len());
        let text = String::from_utf16_lossy(&alias_buf[..end]).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    pub fn query_interfaces(primary_ip: Option<Ipv4Addr>) -> Vec<NetworkInterfaceInfo> {
        let mut seen_ips = HashSet::new();
        let mut results = Vec::new();

        for (ip, if_index) in get_raw_ipv4_rows() {
            if !is_usable_lan_ipv4(ip) || is_cgnat_or_vpn_ipv4(ip) || !seen_ips.insert(ip) {
                continue;
            }

            let mut if_row: MibIfRow = unsafe { std::mem::zeroed() };
            if_row.dw_index = if_index;
            if unsafe { GetIfEntry(&mut if_row) } != NO_ERROR {
                continue;
            }

            if matches!(
                if_row.dw_type,
                IF_TYPE_SOFTWARE_LOOPBACK | IF_TYPE_TUNNEL | IF_TYPE_PPP | IF_TYPE_PROP_VIRTUAL
            ) {
                continue;
            }

            if if_row.dw_oper_status != IF_OPER_STATUS_CONNECTED
                && if_row.dw_oper_status != IF_OPER_STATUS_OPERATIONAL
            {
                continue;
            }

            let descr_len = (if_row.dw_descr_len as usize).min(MAXLEN_IFDESCR);
            let descr_slice = &if_row.b_descr[..descr_len];
            let descr_end = descr_slice
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(descr_slice.len());
            let description = String::from_utf8_lossy(&descr_slice[..descr_end])
                .trim()
                .to_string();

            let alias = resolve_interface_alias(if_index).unwrap_or_else(|| {
                if !description.is_empty() {
                    description.clone()
                } else {
                    format!("Interface #{if_index}")
                }
            });

            if is_virtual_or_excluded_adapter(&alias, &description) {
                continue;
            }

            let kind = match if_row.dw_type {
                IF_TYPE_IEEE80211 => "wifi".to_string(),
                IF_TYPE_ETHERNET_CSMACD => {
                    let guessed = classify_interface_kind(&alias, &description);
                    if guessed == "wifi" {
                        "wifi".to_string()
                    } else {
                        "ethernet".to_string()
                    }
                }
                _ => classify_interface_kind(&alias, &description).to_string(),
            };

            results.push(NetworkInterfaceInfo {
                name: alias,
                ip: ip.to_string(),
                kind,
                is_primary: primary_ip == Some(ip),
            });
        }

        results
    }
}

// ============================================================================
// macOS & Linux Implementation (`ip -4 -o addr` / `ifconfig` + UDP Route Probe)
// ============================================================================
#[cfg(not(target_os = "windows"))]
fn collect_all_host_ipv4s() -> HashSet<Ipv4Addr> {
    let mut set = HashSet::new();
    set.insert(Ipv4Addr::LOCALHOST);
    for (ip, _) in unix_imp::enumerate_unix_ipv4s() {
        set.insert(ip);
    }
    if let Some(primary) = detect_primary_outbound_ipv4() {
        set.insert(primary);
    }
    set
}

#[cfg(not(target_os = "windows"))]
fn query_active_lan_interfaces(primary_ip: Option<Ipv4Addr>) -> Vec<NetworkInterfaceInfo> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let hw_ports = unix_imp::macos_hardware_port_names();

    for (ip, raw_name) in unix_imp::enumerate_unix_ipv4s() {
        if !is_usable_lan_ipv4(ip) || is_cgnat_or_vpn_ipv4(ip) || !seen.insert(ip) {
            continue;
        }
        let friendly = hw_ports
            .get(&raw_name)
            .cloned()
            .unwrap_or_else(|| raw_name.clone());

        if is_virtual_or_excluded_adapter(&raw_name, &friendly) {
            continue;
        }

        let display_name = if friendly != raw_name {
            format!("{friendly} ({raw_name})")
        } else {
            raw_name.clone()
        };

        let kind = classify_interface_kind(&raw_name, &friendly).to_string();
        out.push(NetworkInterfaceInfo {
            name: display_name,
            ip: ip.to_string(),
            kind,
            is_primary: primary_ip == Some(ip),
        });
    }
    out
}

#[cfg(not(target_os = "windows"))]
mod unix_imp {
    use super::*;
    use std::collections::HashMap;
    use std::process::Command;

    pub fn enumerate_unix_ipv4s() -> Vec<(Ipv4Addr, String)> {
        // Try `ip -4 -o addr show up` first (Linux)
        if let Ok(output) = Command::new("ip")
            .args(["-4", "-o", "addr", "show", "up"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut list = Vec::new();
                for line in stdout.lines() {
                    // Example: `2: wlan0    inet 192.168.1.45/24 brd 192.168.1.255 scope global dynamic wlan0`
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 4 {
                        let iface = parts[1].trim_end_matches(':').to_string();
                        if let Some(inet_idx) = parts.iter().position(|&p| p == "inet") {
                            if let Some(cidr) = parts.get(inet_idx + 1) {
                                let ip_str = cidr.split('/').next().unwrap_or("");
                                if let Ok(ip) = ip_str.parse::<Ipv4Addr>() {
                                    list.push((ip, iface));
                                }
                            }
                        }
                    }
                }
                if !list.is_empty() {
                    return list;
                }
            }
        }

        // Fallback to `ifconfig` (macOS / BSD / minimal Linux)
        let Ok(output) = Command::new("ifconfig").output() else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut current_iface = String::new();
        let mut current_up = true;
        let mut list = Vec::new();

        for line in stdout.lines() {
            if !line.starts_with(' ') && !line.starts_with('\t') && line.contains(':') {
                let name = line.split(':').next().unwrap_or("").trim();
                current_iface = name.to_string();
                current_up = line.contains("<UP,") || line.contains(",UP,") || line.contains(",UP>");
                continue;
            }
            if !current_up || current_iface.is_empty() {
                continue;
            }
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("inet ") {
                let ip_token = rest
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_start_matches("addr:");
                if let Ok(ip) = ip_token.parse::<Ipv4Addr>() {
                    list.push((ip, current_iface.clone()));
                }
            }
        }

        list
    }

    pub fn macos_hardware_port_names() -> HashMap<String, String> {
        #[cfg(target_os = "macos")]
        {
            let mut map = HashMap::new();
            if let Ok(output) = Command::new("networksetup")
                .arg("-listallhardwareports")
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let mut current_port: Option<String> = None;
                    for line in stdout.lines() {
                        let trimmed = line.trim();
                        if let Some(port) = trimmed.strip_prefix("Hardware Port:") {
                            current_port = Some(port.trim().to_string());
                        } else if let Some(dev) = trimmed.strip_prefix("Device:") {
                            if let Some(port_name) = current_port.take() {
                                map.insert(dev.trim().to_string(), port_name);
                            }
                        }
                    }
                }
            }
            map
        }
        #[cfg(not(target_os = "macos"))]
        {
            HashMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_virtual_and_loopback_interfaces() {
        assert!(is_virtual_or_excluded_adapter(
            "vEthernet (WSL (Hyper-V firewall))",
            "Hyper-V Virtual Ethernet Adapter"
        ));
        assert!(is_virtual_or_excluded_adapter(
            "docker0",
            "Linux bridge"
        ));
        assert!(is_virtual_or_excluded_adapter(
            "VMware Network Adapter VMnet8",
            "VMware Virtual Ethernet Adapter"
        ));
        assert!(is_virtual_or_excluded_adapter(
            "Tailscale",
            "Tailscale Tunnel"
        ));
        assert!(!is_virtual_or_excluded_adapter(
            "Wi-Fi",
            "Intel(R) Wi-Fi 6E AX211 160MHz"
        ));
        assert!(!is_virtual_or_excluded_adapter(
            "Ethernet",
            "Realtek PCIe GbE Family Controller"
        ));

        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_usable_lan_ipv4(Ipv4Addr::new(169, 254, 12, 5)));
        assert!(is_usable_lan_ipv4(Ipv4Addr::new(192, 168, 1, 45)));
        assert!(is_cgnat_or_vpn_ipv4(Ipv4Addr::new(100, 101, 102, 103)));
    }

    #[test]
    fn enumerates_host_interfaces_without_loopback() {
        let interfaces = list_network_interfaces();
        for iface in &interfaces {
            assert_ne!(iface.ip, "127.0.0.1");
            assert!(!iface.ip.starts_with("169.254."));
        }
        assert!(is_host_own_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        // Arbitrary unallocated LAN IP should not match this host (unless coincidentally assigned)
        let _ = is_host_own_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 250)));
    }
}
