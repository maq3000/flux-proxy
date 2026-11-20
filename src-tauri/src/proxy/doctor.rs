use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::models::{BindHostMode, DoctorCheckResult, NetworkInterfaceInfo, ProxyError, ProxyStatus};
use crate::proxy::network::{
    detect_primary_outbound_ipv4, is_cgnat_or_vpn_ipv4, list_network_interfaces_with_options,
};
use crate::proxy::server::{
    bind_listeners_with_cleanup, format_bind_sock_addr, resolve_bind_plan, ProxyEngineController,
};
use crate::proxy::sysproxy::resolve_sysproxy_host_for_bind;

const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const TCP_REACHABILITY_TIMEOUT: Duration = Duration::from_millis(600);

fn format_endpoints_label(ips: &[String], port: u16) -> String {
    if ips.is_empty() {
        return format!("127.0.0.1:{port}");
    }
    ips.iter()
        .map(|ip| format_bind_sock_addr(ip, port))
        .collect::<Vec<_>>()
        .join(" + ")
}

fn resolve_target_ips_for_status(status: &ProxyStatus) -> Vec<String> {
    if !status.bound_ips.is_empty() {
        return status.bound_ips.clone();
    }
    match resolve_bind_plan(
        status.bind_mode,
        status.specific_bind_ip.as_deref(),
        status.also_bind_loopback,
    ) {
        Ok((_, _, _, target_ips, _)) => target_ips,
        Err(_) => vec![status.bind_addr.clone()],
    }
}

fn resolve_probe_socket_addr(status: &ProxyStatus) -> String {
    if status.bind_mode == BindHostMode::Specific && !status.also_bind_loopback {
        if let Some(ref ip) = status.specific_bind_ip {
            return format_bind_sock_addr(ip, status.port);
        }
    }
    if status.bound_ips.iter().any(|ip| ip == "127.0.0.1" || ip == "0.0.0.0")
        || status.bind_addr == "127.0.0.1"
        || status.bind_addr == "0.0.0.0"
    {
        return format!("127.0.0.1:{}", status.port);
    }
    if let Some(first_ip) = status.bound_ips.first() {
        return format_bind_sock_addr(first_ip, status.port);
    }
    format_bind_sock_addr(&status.bind_addr, status.port)
}

async fn check_port_binding(status: &ProxyStatus) -> DoctorCheckResult {
    let target_ips = resolve_target_ips_for_status(status);
    let endpoints = format_endpoints_label(&target_ips, status.port);
    let mode_label = match status.bind_mode {
        BindHostMode::Loopback => "Loopback (127.0.0.1)",
        BindHostMode::AllInterfaces => "All Interfaces (0.0.0.0)",
        BindHostMode::Specific => "Specific Interface",
    };

    if status.running {
        return DoctorCheckResult {
            id: "port_binding".to_string(),
            title: "Привязка порта и сокетов прокси".to_string(),
            status: "ok".to_string(),
            summary: format!("Прокси-листенер активен на {endpoints}"),
            details: format!(
                "Режим привязки: {mode_label}, порт: {}, сокеты: [{}], remote/LAN: {}.",
                status.port,
                target_ips.join(", "),
                if status.allow_remote { "вкл" } else { "выкл" }
            ),
            can_auto_fix: false,
            fix_label: None,
        };
    }

    match bind_listeners_with_cleanup(&target_ips, status.port, 1).await {
        Ok((trial_listeners, actual_port)) => {
            drop(trial_listeners);
            DoctorCheckResult {
                id: "port_binding".to_string(),
                title: "Привязка порта и сокетов прокси".to_string(),
                status: "warning".to_string(),
                summary: format!("Прокси остановлен, но порт {actual_port} свободен ({endpoints})"),
                details: format!(
                    "Пробный TcpListener::bind прошёл успешно на [{endpoints}]. Запустите захват трафика (F12) или нажмите кнопку исправления для запуска."
                ),
                can_auto_fix: true,
                fix_label: Some("Запустить листенер прокси".to_string()),
            }
        }
        Err(err) => DoctorCheckResult {
            id: "port_binding".to_string(),
            title: "Привязка порта и сокетов прокси".to_string(),
            status: "error".to_string(),
            summary: format!("Порт {} недоступен для привязки ({endpoints})", status.port),
            details: format!(
                "Пробный TcpListener::bind завершился ошибкой: {err}. Автоисправление перезапустит листенер (при занятом порте или недоступном интерфейсе выберет свободный порт на 127.0.0.1)."
            ),
            can_auto_fix: true,
            fix_label: Some("Перезапустить листенер".to_string()),
        },
    }
}

async fn check_root_ca_trust(controller: &ProxyEngineController) -> DoctorCheckResult {
    let ca = controller.context.ca.clone();
    let ca_res = tokio::task::spawn_blocking(move || ca.info_with_trust_status()).await;

    match ca_res {
        Ok(info) => {
            let cer_exists = Path::new(&info.cert_cer_path).is_file();
            let pem_exists = Path::new(&info.cert_pem_path).is_file();
            if info.is_trusted {
                DoctorCheckResult {
                    id: "root_ca_trust".to_string(),
                    title: "Доверие к HTTPS Root CA".to_string(),
                    status: "ok".to_string(),
                    summary: "FluxProxy Root CA установлен в доверенном хранилище ОС".to_string(),
                    details: format!(
                        "Subject: {}\nSHA-256: {}\nДействителен до: {}\nФайл .cer: {} ({})",
                        info.subject,
                        info.sha256_fingerprint,
                        info.valid_until,
                        info.cert_cer_path,
                        if cer_exists && pem_exists { "OK" } else { "часть файлов отсутствует" }
                    ),
                    can_auto_fix: false,
                    fix_label: None,
                }
            } else {
                DoctorCheckResult {
                    id: "root_ca_trust".to_string(),
                    title: "Доверие к HTTPS Root CA".to_string(),
                    status: "error".to_string(),
                    summary: "Root CA не установлен в доверенные корневые центры ОС".to_string(),
                    details: format!(
                        "Браузеры и CLI-клиенты будут отклонять HTTPS MITM-сертификаты с ошибкой NET::ERR_CERT_AUTHORITY_INVALID. Файл сертификата: {} (существует: {}). Нажмите «Установить Root CA в ОС» для импорта.",
                        info.cert_cer_path,
                        if cer_exists { "да" } else { "нет" }
                    ),
                    can_auto_fix: true,
                    fix_label: Some("Установить Root CA в ОС".to_string()),
                }
            }
        }
        Err(err) => DoctorCheckResult {
            id: "root_ca_trust".to_string(),
            title: "Доверие к HTTPS Root CA".to_string(),
            status: "error".to_string(),
            summary: "Не удалось проверить статус Root CA в хранилище ОС".to_string(),
            details: format!("Ошибка фоновой задачи проверки CA: {err}"),
            can_auto_fix: true,
            fix_label: Some("Установить Root CA в ОС".to_string()),
        },
    }
}

pub(crate) fn evaluate_system_proxy_sync(
    controller: &ProxyEngineController,
    status: &ProxyStatus,
) -> DoctorCheckResult {
    let expected_host = resolve_sysproxy_host_for_bind(
        status.bind_mode,
        status.specific_bind_ip.as_deref(),
        status.also_bind_loopback,
    );
    let expected_endpoint = format_bind_sock_addr(&expected_host, status.port);
    let (sys_enabled, sys_err) = controller
        .sysproxy
        .status_for_listener(&expected_host, status.port);

    if let Some(err_msg) = sys_err.or_else(|| status.system_proxy_error.clone()) {
        return DoctorCheckResult {
            id: "system_proxy_sync".to_string(),
            title: "Синхронизация системного прокси ОС".to_string(),
            status: "error".to_string(),
            summary: format!("Системный прокси не синхронизирован с {expected_endpoint}"),
            details: format!(
                "{err_msg}. Ожидаемый адрес: {expected_endpoint}, autoSystemProxy: {}. Нажмите «Восстановить системный прокси», чтобы привязать ОС к FluxProxy.",
                if status.auto_system_proxy { "вкл" } else { "выкл" }
            ),
            can_auto_fix: true,
            fix_label: Some("Восстановить системный прокси".to_string()),
        };
    }

    if !status.running && sys_enabled {
        return DoctorCheckResult {
            id: "system_proxy_sync".to_string(),
            title: "Синхронизация системного прокси ОС".to_string(),
            status: "error".to_string(),
            summary: format!(
                "Системный прокси ОС указывает на {expected_endpoint}, но движок остановлен"
            ),
            details: "Системные браузеры будут получать ERR_PROXY_CONNECTION_FAILED, пока листенер не запущен. Автоисправление запустит прокси и синхронизирует системные настройки.".to_string(),
            can_auto_fix: true,
            fix_label: Some("Восстановить системный прокси".to_string()),
        };
    }

    if status.running && sys_enabled {
        return DoctorCheckResult {
            id: "system_proxy_sync".to_string(),
            title: "Синхронизация системного прокси ОС".to_string(),
            status: "ok".to_string(),
            summary: format!("Системный прокси ОС активен и указывает на {expected_endpoint}"),
            details: format!(
                "Настройки ОС совпадают с активным листенером ({expected_endpoint}). Режим Act as System Proxy: {}.",
                if status.auto_system_proxy { "вкл" } else { "выкл" }
            ),
            can_auto_fix: false,
            fix_label: None,
        };
    }

    if status.running && status.auto_system_proxy && !sys_enabled {
        return DoctorCheckResult {
            id: "system_proxy_sync".to_string(),
            title: "Синхронизация системного прокси ОС".to_string(),
            status: "warning".to_string(),
            summary: format!(
                "Режим Auto System Proxy включён, но системный прокси не направлен на {expected_endpoint}"
            ),
            details: "Вероятно, системный прокси был временно отключён вручную или сторонним приложением. Нажмите «Включить системный прокси ОС» для восстановления.".to_string(),
            can_auto_fix: true,
            fix_label: Some("Включить системный прокси ОС".to_string()),
        };
    }

    DoctorCheckResult {
        id: "system_proxy_sync".to_string(),
        title: "Синхронизация системного прокси ОС".to_string(),
        status: "warning".to_string(),
        summary: "Системный прокси ОС отключён (режим Port Only / ручной HTTP_PROXY)".to_string(),
        details: format!(
            "Браузеры не перехватываются автоматически. Для захвата трафика ОС включите системный прокси на {expected_endpoint} или используйте HTTP_PROXY=http://{expected_endpoint}."
        ),
        can_auto_fix: true,
        fix_label: Some("Включить системный прокси ОС".to_string()),
    }
}

pub(crate) fn evaluate_vpn_interfaces(
    interfaces: &[NetworkInterfaceInfo],
    primary_outbound: Option<Ipv4Addr>,
) -> DoctorCheckResult {
    let mut vpn_hits: Vec<String> = Vec::new();
    for iface in interfaces {
        let is_cgnat = iface
            .ip
            .parse::<Ipv4Addr>()
            .map(is_cgnat_or_vpn_ipv4)
            .unwrap_or(false);
        if iface.kind == "vpn" || is_cgnat {
            let tag = if is_cgnat { "CGNAT/VPN" } else { "TUN/VPN" };
            vpn_hits.push(format!("{} ({}, {})", iface.name, iface.ip, tag));
        }
    }

    let primary_is_vpn = primary_outbound.map(is_cgnat_or_vpn_ipv4).unwrap_or(false);
    if primary_is_vpn {
        if let Some(ip) = primary_outbound {
            let ip_s = ip.to_string();
            if !vpn_hits.iter().any(|h| h.contains(&ip_s)) {
                vpn_hits.push(format!("Primary Outbound Route ({ip_s}, CGNAT/VPN)"));
            }
        }
    }

    if vpn_hits.is_empty() {
        let primary_note = primary_outbound
            .map(|ip| format!("Основной исходящий маршрут: {ip}. "))
            .unwrap_or_default();
        return DoctorCheckResult {
            id: "vpn_interface_check".to_string(),
            title: "Конфликты VPN / TUN / CGNAT маршрутизации".to_string(),
            status: "ok".to_string(),
            summary: "Активных TUN/VPN/CGNAT интерфейсов не обнаружено".to_string(),
            details: format!(
                "{primary_note}Проверено сетевых адаптеров: {}. Сторонних VPN-туннелей, перехватывающих системный прокси, не найдено.",
                interfaces.len()
            ),
            can_auto_fix: false,
            fix_label: None,
        };
    }

    let primary_warning = if primary_is_vpn {
        "Основной шлюз по умолчанию сейчас идёт через CGNAT/VPN-интерфейс! "
    } else {
        ""
    };

    DoctorCheckResult {
        id: "vpn_interface_check".to_string(),
        title: "Конфликты VPN / TUN / CGNAT маршрутизации".to_string(),
        status: "warning".to_string(),
        summary: format!(
            "Обнаружены активные VPN/TUN/CGNAT маршруты ({}): {}",
            vpn_hits.len(),
            vpn_hits.join(", ")
        ),
        details: format!(
            "{primary_warning}VPN-клиенты в режиме TUN (WireGuard/Wintun, Tailscale, OpenVPN, Clash/Sing-box TUN) могут перехватывать трафик в обход системного прокси ОС или сбрасывать WinINet ProxyServer. Рекомендация: отключите TUN-режим на время отладки либо добавьте 127.0.0.1 и локальную подсеть в исключения VPN."
        ),
        can_auto_fix: false,
        fix_label: None,
    }
}

async fn check_vpn_interfaces() -> DoctorCheckResult {
    let res = tokio::task::spawn_blocking(|| {
        let interfaces = list_network_interfaces_with_options(true);
        let primary = detect_primary_outbound_ipv4();
        evaluate_vpn_interfaces(&interfaces, primary)
    })
    .await;

    match res {
        Ok(check) => check,
        Err(err) => DoctorCheckResult {
            id: "vpn_interface_check".to_string(),
            title: "Конфликты VPN / TUN / CGNAT маршрутизации".to_string(),
            status: "warning".to_string(),
            summary: "Не удалось просканировать сетевые интерфейсы".to_string(),
            details: format!("Ошибка фоновой задачи анализа сетевых адаптеров: {err}"),
            can_auto_fix: false,
            fix_label: None,
        },
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct FirewallInspection {
    pub inspected: bool,
    pub any_profile_enabled: bool,
    pub blocks_inbound_by_default: bool,
    pub active_profiles_summary: String,
    pub has_flux_allow_rule: Option<bool>,
}

pub(crate) fn evaluate_firewall_result(
    status: &ProxyStatus,
    local_tcp_ok: Option<Result<(), String>>,
    fw: &FirewallInspection,
) -> DoctorCheckResult {
    let port = status.port;
    let lan_exposed = status.allow_remote
        || status.bind_mode == BindHostMode::AllInterfaces
        || (status.bind_mode == BindHostMode::Specific
            && status.specific_bind_ip.as_deref() != Some("127.0.0.1")
            && status.specific_bind_ip.as_deref() != Some("::1"));

    let fix_cmd = if cfg!(target_os = "windows") {
        format!(
            "netsh advfirewall firewall add rule name=\"FluxProxy\" dir=in action=allow protocol=TCP localport={port}"
        )
    } else if cfg!(target_os = "macos") {
        "System Settings → Network → Firewall → Options → Разрешить входящие для FluxProxy".to_string()
    } else {
        format!("sudo ufw allow {port}/tcp")
    };

    if let Some(Err(tcp_err)) = local_tcp_ok {
        return DoctorCheckResult {
            id: "firewall_check".to_string(),
            title: "Брандмауэр и доступность порта".to_string(),
            status: "error".to_string(),
            summary: format!("Локальный порт {port} не отвечает на TCP-подключение"),
            details: format!(
                "Попытка TCP-подключения к активному сокету прокси завершилась ошибкой: {tcp_err}. Проверьте антивирус/брандмауэр или перезапустите листенер."
            ),
            can_auto_fix: false,
            fix_label: None,
        };
    }

    if !lan_exposed {
        let local_note = match local_tcp_ok {
            Some(Ok(())) => format!("Локальный TCP-сокет 127.0.0.1:{port} принимает подключения. "),
            None => String::new(),
            Some(Err(_)) => String::new(),
        };
        let profile_note = if fw.inspected && !fw.active_profiles_summary.is_empty() {
            format!("Профили брандмауэра: {}. ", fw.active_profiles_summary)
        } else {
            String::new()
        };
        return DoctorCheckResult {
            id: "firewall_check".to_string(),
            title: "Брандмауэр и доступность порта".to_string(),
            status: "ok".to_string(),
            summary: format!("Loopback-режим (127.0.0.1:{port}) защищён от внешней блокировки"),
            details: format!(
                "{local_note}{profile_note}Внешний брандмауэр не фильтрует loopback. При включении LAN/Mobile режима (0.0.0.0 или Wi-Fi IP) может понадобиться разрешение: `{fix_cmd}`."
            ),
            can_auto_fix: false,
            fix_label: None,
        };
    }

    if fw.inspected {
        if !fw.any_profile_enabled || !fw.blocks_inbound_by_default {
            return DoctorCheckResult {
                id: "firewall_check".to_string(),
                title: "Брандмауэр и доступность порта".to_string(),
                status: "ok".to_string(),
                summary: format!("Входящий LAN-трафик на порт {port} не блокируется политикой по умолчанию"),
                details: format!("Состояние профилей: {}.", fw.active_profiles_summary),
                can_auto_fix: false,
                fix_label: None,
            };
        }

        if fw.has_flux_allow_rule == Some(true) {
            return DoctorCheckResult {
                id: "firewall_check".to_string(),
                title: "Брандмауэр и доступность порта".to_string(),
                status: "ok".to_string(),
                summary: format!("Найдено разрешающее правило брандмауэра для FluxProxy / порта {port}"),
                details: format!(
                    "Профили: {}. Входящие подключения с мобильных/LAN устройств разрешены.",
                    fw.active_profiles_summary
                ),
                can_auto_fix: false,
                fix_label: None,
            };
        }

        return DoctorCheckResult {
            id: "firewall_check".to_string(),
            title: "Брандмауэр и доступность порта".to_string(),
            status: "warning".to_string(),
            summary: format!(
                "Брандмауэр ОС активен, правило для входящего порта {port} (LAN) не обнаружено"
            ),
            details: format!(
                "Профили: {}. В режиме AllInterfaces / Specific LAN внешние устройства (iOS/Android) могут получать таймаут при подключении. Выполните от имени администратора:\n{fix_cmd}",
                fw.active_profiles_summary
            ),
            can_auto_fix: false,
            fix_label: None,
        };
    }

    DoctorCheckResult {
        id: "firewall_check".to_string(),
        title: "Брандмауэр и доступность порта".to_string(),
        status: "warning".to_string(),
        summary: format!("LAN-режим активен (порт {port}); убедитесь, что брандмауэр разрешает входящие"),
        details: format!(
            "Проверка правил брандмауэра ОС ограничена без прав администратора (UAC не запрашивается). Если мобильное устройство не может подключиться к порту {port}, добавьте правило:\n{fix_cmd}"
        ),
        can_auto_fix: false,
        fix_label: None,
    }
}

#[cfg(target_os = "windows")]
fn inspect_os_firewall_non_privileged(port: u16) -> FirewallInspection {
    use std::ffi::c_void;
    use std::ptr::null_mut;

    type HKey = *mut c_void;
    const HKEY_LOCAL_MACHINE: HKey = (0x8000_0002u32 as i32 as isize) as HKey;
    const KEY_QUERY_VALUE: u32 = 0x0001;
    const REG_DWORD: u32 = 4;
    const REG_SZ: u32 = 1;
    const ERROR_SUCCESS: u32 = 0;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            h_key: HKey,
            lp_sub_key: *const u16,
            ul_options: u32,
            sam_desired: u32,
            phk_result: *mut HKey,
        ) -> u32;
        fn RegQueryValueExW(
            h_key: HKey,
            lp_value_name: *const u16,
            lp_reserved: *mut u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> u32;
        fn RegEnumValueW(
            h_key: HKey,
            dw_index: u32,
            lp_value_name: *mut u16,
            lpcch_value_name: *mut u32,
            lp_reserved: *mut u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> u32;
        fn RegCloseKey(h_key: HKey) -> u32;
    }

    struct KeyGuard(HKey);
    impl Drop for KeyGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = RegCloseKey(self.0);
                }
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open_hklm(subkey: &str) -> Option<KeyGuard> {
        let wide = to_wide(subkey);
        let mut hkey: HKey = null_mut();
        let rc = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                wide.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        };
        if rc == ERROR_SUCCESS {
            Some(KeyGuard(hkey))
        } else {
            None
        }
    }

    fn query_dword(hkey: HKey, name: &str) -> Option<u32> {
        let wide = to_wide(name);
        let mut reg_type: u32 = 0;
        let mut buf = [0u8; 4];
        let mut len: u32 = 4;
        let rc = unsafe {
            RegQueryValueExW(
                hkey,
                wide.as_ptr(),
                null_mut(),
                &mut reg_type,
                buf.as_mut_ptr(),
                &mut len,
            )
        };
        if rc == ERROR_SUCCESS && reg_type == REG_DWORD && len == 4 {
            Some(u32::from_le_bytes(buf))
        } else {
            None
        }
    }

    let profiles = [
        (
            "Private",
            "SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\StandardProfile",
        ),
        (
            "Public",
            "SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\PublicProfile",
        ),
        (
            "Domain",
            "SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\DomainProfile",
        ),
    ];

    let mut inspected = false;
    let mut any_enabled = false;
    let mut blocks_inbound = false;
    let mut parts = Vec::new();

    for (label, key_path) in profiles {
        if let Some(guard) = open_hklm(key_path) {
            inspected = true;
            let enabled = query_dword(guard.0, "EnableFirewall").unwrap_or(1) != 0;
            let def_inbound_block = query_dword(guard.0, "DefaultInboundAction").unwrap_or(1) != 0;
            if enabled {
                any_enabled = true;
                if def_inbound_block {
                    blocks_inbound = true;
                }
            }
            parts.push(format!(
                "{label}={}",
                if enabled {
                    if def_inbound_block {
                        "ON(BlockInbound)"
                    } else {
                        "ON(AllowInbound)"
                    }
                } else {
                    "OFF"
                }
            ));
        }
    }

    let port_token = format!("lport={port}");
    let mut has_allow_rule = None;
    if let Some(rules_guard) =
        open_hklm("SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules")
    {
        let mut found = false;
        let mut idx: u32 = 0;
        let mut name_buf = vec![0u16; 512];
        let mut data_buf = vec![0u8; 4096];

        loop {
            let mut name_len = name_buf.len() as u32;
            let mut data_len = data_buf.len() as u32;
            let mut reg_type: u32 = 0;
            let rc = unsafe {
                RegEnumValueW(
                    rules_guard.0,
                    idx,
                    name_buf.as_mut_ptr(),
                    &mut name_len,
                    null_mut(),
                    &mut reg_type,
                    data_buf.as_mut_ptr(),
                    &mut data_len,
                )
            };
            if rc != ERROR_SUCCESS {
                break;
            }
            idx += 1;
            if reg_type == REG_SZ && data_len >= 2 {
                let wide_slice: Vec<u16> = data_buf[..(data_len as usize).min(data_buf.len())]
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect();
                let rule_str = String::from_utf16_lossy(&wide_slice)
                    .trim_end_matches('\0')
                    .to_ascii_lowercase();
                let is_active = rule_str.contains("active=true");
                let is_allow_in =
                    rule_str.contains("action=allow") && rule_str.contains("dir=in");
                let matches_flux_or_port = rule_str.contains("fluxproxy")
                    || rule_str.contains("flux-proxy")
                    || rule_str
                        .split('|')
                        .any(|seg| seg.trim() == port_token);
                if is_active && is_allow_in && matches_flux_or_port {
                    found = true;
                    break;
                }
            }
            if idx > 8192 {
                break;
            }
        }
        has_allow_rule = Some(found);
    }

    FirewallInspection {
        inspected,
        any_profile_enabled: any_enabled,
        blocks_inbound_by_default: blocks_inbound,
        active_profiles_summary: parts.join(", "),
        has_flux_allow_rule: has_allow_rule,
    }
}

#[cfg(not(target_os = "windows"))]
fn inspect_os_firewall_non_privileged(_port: u16) -> FirewallInspection {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/libexec/ApplicationFirewall/socketfilterfw")
            .arg("--getglobalstate")
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout).to_ascii_lowercase();
                let enabled = text.contains("enabled") && !text.contains("disabled");
                return FirewallInspection {
                    inspected: true,
                    any_profile_enabled: enabled,
                    blocks_inbound_by_default: enabled,
                    active_profiles_summary: if enabled {
                        "macOS Application Firewall=ON".to_string()
                    } else {
                        "macOS Application Firewall=OFF".to_string()
                    },
                    has_flux_allow_rule: None,
                };
            }
        }
    }

    FirewallInspection::default()
}

async fn check_firewall(status: &ProxyStatus) -> DoctorCheckResult {
    let local_tcp_ok = if status.running {
        let probe_addr = resolve_probe_socket_addr(status);
        Some(
            match tokio::time::timeout(TCP_REACHABILITY_TIMEOUT, TcpStream::connect(&probe_addr)).await
            {
                Ok(Ok(stream)) => {
                    drop(stream);
                    Ok(())
                }
                Ok(Err(err)) => Err(err.to_string()),
                Err(_) => Err(format!("Таймаут подключения к {probe_addr}")),
            },
        )
    } else {
        None
    };

    let port = status.port;
    let fw = tokio::task::spawn_blocking(move || inspect_os_firewall_non_privileged(port))
        .await
        .unwrap_or_default();

    evaluate_firewall_result(status, local_tcp_ok, &fw)
}

pub(crate) async fn probe_proxy_health_endpoint(probe_addr: &str) -> Result<(u16, String, u64), String> {
    let started = Instant::now();
    let connect_res = tokio::time::timeout(HEALTH_PROBE_TIMEOUT, TcpStream::connect(probe_addr)).await;
    let mut stream = match connect_res {
        Ok(Ok(s)) => s,
        Ok(Err(err)) => {
            return Err(format!("Не удалось подключиться к {probe_addr}: {err}"));
        }
        Err(_) => {
            return Err(format!("Таймаут TCP-подключения к {probe_addr}"));
        }
    };

    let request = b"GET http://flux.proxy/health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\nUser-Agent: FluxProxy-Doctor/1.0\r\n\r\n";
    if let Err(err) = tokio::time::timeout(HEALTH_PROBE_TIMEOUT, stream.write_all(request)).await {
        return Err(format!("Ошибка отправки health-запроса на {probe_addr}: {err}"));
    }

    let mut raw = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        if raw.len() >= 16 * 1024 {
            break;
        }
        match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => raw.extend_from_slice(&buf[..n]),
            Ok(Err(err)) => {
                return Err(format!("Ошибка чтения ответа от {probe_addr}: {err}"));
            }
            Err(_) => {
                return Err(format!("Таймаут ожидания ответа от {probe_addr}"));
            }
        }
    }

    let text = String::from_utf8_lossy(&raw);
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("Некорректный HTTP-ответ от {probe_addr}: '{status_line}'"))?;

    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.trim().to_string())
        .unwrap_or_default();

    let elapsed_ms = started.elapsed().as_millis() as u64;
    if status_code != 200 {
        return Err(format!("Ожидался HTTP 200, получен HTTP {status_code} ({body})"));
    }
    if !body.contains("\"ok\"") {
        return Err(format!("Неожиданное тело /health: '{body}'"));
    }

    Ok((status_code, body, elapsed_ms))
}

async fn check_loopback_e2e(status: &ProxyStatus) -> DoctorCheckResult {
    let probe_addr = resolve_probe_socket_addr(status);
    if !status.running {
        return DoctorCheckResult {
            id: "loopback_e2e".to_string(),
            title: "End-to-End loopback-маршрутизация (/health)".to_string(),
            status: "error".to_string(),
            summary: format!("Прокси остановлен — сокет {probe_addr} не прослушивается"),
            details: "Запрос GET http://flux.proxy/health не может быть выполнен, пока прокси-движок остановлен.".to_string(),
            can_auto_fix: true,
            fix_label: Some("Запустить листенер прокси".to_string()),
        };
    }

    match probe_proxy_health_endpoint(&probe_addr).await {
        Ok((code, body, elapsed_ms)) => DoctorCheckResult {
            id: "loopback_e2e".to_string(),
            title: "End-to-End loopback-маршрутизация (/health)".to_string(),
            status: "ok".to_string(),
            summary: format!("GET http://flux.proxy/health → HTTP {code} ({elapsed_ms} мс)"),
            details: format!(
                "Локальный сокет {probe_addr} корректно обработал HTTP-запрос и вернул {body} без создания лишних сессий в TrafficStore."
            ),
            can_auto_fix: false,
            fix_label: None,
        },
        Err(err) => DoctorCheckResult {
            id: "loopback_e2e".to_string(),
            title: "End-to-End loopback-маршрутизация (/health)".to_string(),
            status: "error".to_string(),
            summary: format!("Сбой E2E-проверки через {probe_addr}"),
            details: format!(
                "{err}. Попробуйте перезапустить листенер прокси кнопкой автоисправления."
            ),
            can_auto_fix: true,
            fix_label: Some("Перезапустить листенер прокси".to_string()),
        },
    }
}

pub async fn run_proxy_doctor(controller: &ProxyEngineController) -> Vec<DoctorCheckResult> {
    let status = controller.status().await;

    let port_check = check_port_binding(&status).await;
    let ca_check = check_root_ca_trust(controller).await;
    let sysproxy_check = evaluate_system_proxy_sync(controller, &status);
    let vpn_check = check_vpn_interfaces().await;
    let firewall_check = check_firewall(&status).await;
    let loopback_check = check_loopback_e2e(&status).await;

    vec![
        port_check,
        ca_check,
        sysproxy_check,
        vpn_check,
        firewall_check,
        loopback_check,
    ]
}

async fn restart_listener_with_recovery(
    controller: &ProxyEngineController,
) -> Result<ProxyStatus, ProxyError> {
    let current = controller.status().await;
    let desired_port = if current.port == 0 { 8888 } else { current.port };

    if current.running {
        controller.stop().await;
    }

    if let Ok(started) = controller.start_with_config(desired_port).await {
        return Ok(started);
    }

    // If Specific / AllInterfaces bind failed (e.g. disconnected Wi-Fi adapter), fall back to Loopback
    if current.bind_mode != BindHostMode::Loopback {
        let _ = controller
            .set_bind_configuration(BindHostMode::Loopback, None, true)
            .await;
        if let Ok(started) = controller.start_with_config(desired_port).await {
            return Ok(started);
        }
    }

    // If desired_port is occupied by another application, try nearby ports before ephemeral :0
    for offset in 1..=10 {
        if let Some(candidate) = desired_port.checked_add(offset) {
            if let Ok(started) = controller.start_with_config(candidate).await {
                return Ok(started);
            }
        }
    }

    controller.start_with_config(0).await
}

pub async fn fix_doctor_issue(
    controller: &ProxyEngineController,
    issue_id: &str,
) -> Result<Vec<DoctorCheckResult>, ProxyError> {
    match issue_id {
        "port_binding" | "loopback_e2e" => {
            restart_listener_with_recovery(controller).await?;
        }
        "root_ca_trust" => {
            let ca = controller.context.ca.clone();
            tokio::task::spawn_blocking(move || ca.install_into_os_trust_store())
                .await
                .map_err(|e| ProxyError::Custom(format!("CA install task join error: {e}")))??;
        }
        "system_proxy_sync" => {
            if !controller.status().await.running {
                restart_listener_with_recovery(controller).await?;
            }
            let updated = controller.set_system_proxy(true).await?;
            if let Some(err) = updated.system_proxy_error {
                return Err(ProxyError::Custom(err));
            }
        }
        "all" => {
            let initial_status = controller.status().await;
            let probe_addr = resolve_probe_socket_addr(&initial_status);
            let needs_listener_restart = !initial_status.running
                || probe_proxy_health_endpoint(&probe_addr).await.is_err();
            if needs_listener_restart {
                restart_listener_with_recovery(controller).await?;
            }

            let post_listener_status = controller.status().await;
            let expected_host = resolve_sysproxy_host_for_bind(
                post_listener_status.bind_mode,
                post_listener_status.specific_bind_ip.as_deref(),
                post_listener_status.also_bind_loopback,
            );
            let (sys_enabled, sys_err) = controller
                .sysproxy
                .status_for_listener(&expected_host, post_listener_status.port);
            if !sys_enabled || sys_err.is_some() || post_listener_status.system_proxy_error.is_some()
            {
                let updated = controller.set_system_proxy(true).await?;
                if let Some(err) = updated.system_proxy_error {
                    return Err(ProxyError::Custom(err));
                }
            }

            let ca = controller.context.ca.clone();
            let ca_trusted = tokio::task::spawn_blocking(move || ca.is_installed_in_os_trust_store())
                .await
                .unwrap_or(false);
            if !ca_trusted {
                let ca_install = controller.context.ca.clone();
                tokio::task::spawn_blocking(move || ca_install.install_into_os_trust_store())
                    .await
                    .map_err(|e| ProxyError::Custom(format!("CA install task join error: {e}")))??;
            }
        }
        other => {
            return Err(ProxyError::Custom(format!(
                "Автоисправление для проверки '{other}' не поддерживается"
            )));
        }
    }

    Ok(run_proxy_doctor(controller).await)
}

pub(crate) fn _is_loopback_ip(ip: &str) -> bool {
    ip.parse::<IpAddr>().map(|a| a.is_loopback()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    use crate::proxy::ca::CertificateAuthority;
    use crate::proxy::filters::ProxyFilterEngine;
    use crate::proxy::rules::RuleEngine;
    use crate::proxy::sysproxy::{
        OsActiveProxyState, OsProxyBackend, PlatformProxySnapshot, SystemProxyManager,
        WindowsProxySnapshot,
    };
    use crate::storage::TrafficStore;

    struct MockOsProxyBackend {
        active: Mutex<Option<(String, u16)>>,
        external_override: Mutex<Option<String>>,
    }

    impl MockOsProxyBackend {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                active: Mutex::new(None),
                external_override: Mutex::new(None),
            })
        }

        fn set_external_hijack(&self, summary: Option<&str>) {
            *self.external_override.lock().unwrap() = summary.map(str::to_string);
            if summary.is_some() {
                *self.active.lock().unwrap() = None;
            }
        }
    }

    impl OsProxyBackend for MockOsProxyBackend {
        fn capture_snapshot(&self) -> Result<PlatformProxySnapshot, ProxyError> {
            Ok(PlatformProxySnapshot::Windows(WindowsProxySnapshot {
                proxy_enable: Some(0),
                proxy_server: None,
                proxy_override: None,
                auto_config_url: None,
            }))
        }

        fn apply_system_proxy(
            &self,
            host: &str,
            port: u16,
            _baseline: &PlatformProxySnapshot,
        ) -> Result<(), ProxyError> {
            *self.external_override.lock().unwrap() = None;
            *self.active.lock().unwrap() = Some((host.to_string(), port));
            Ok(())
        }

        fn restore_snapshot(&self, _snapshot: &PlatformProxySnapshot) -> Result<(), ProxyError> {
            *self.active.lock().unwrap() = None;
            Ok(())
        }

        fn inspect_active_state(
            &self,
            expected_host: &str,
            expected_port: u16,
        ) -> Result<OsActiveProxyState, ProxyError> {
            if let Some(ref hijack) = *self.external_override.lock().unwrap() {
                return Ok(OsActiveProxyState {
                    matches_flux: false,
                    any_proxy_enabled: true,
                    current_target_summary: hijack.clone(),
                });
            }
            match *self.active.lock().unwrap() {
                Some((ref h, p)) => Ok(OsActiveProxyState {
                    matches_flux: h == expected_host && p == expected_port,
                    any_proxy_enabled: true,
                    current_target_summary: format!("{h}:{p}"),
                }),
                None => Ok(OsActiveProxyState {
                    matches_flux: false,
                    any_proxy_enabled: false,
                    current_target_summary: "disabled".to_string(),
                }),
            }
        }
    }

    fn make_test_controller(suffix: &str) -> (ProxyEngineController, Arc<MockOsProxyBackend>, std::path::PathBuf) {
        let tmp_dir = std::env::temp_dir().join(format!(
            "fluxproxy-doctor-test-{suffix}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir).unwrap();

        let ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let rules = Arc::new(RuleEngine::new());
        let filters = Arc::new(ProxyFilterEngine::new());
        let store = Arc::new(TrafficStore::new(tmp_dir.join("doctor.sqlite")).unwrap());
        let backend = MockOsProxyBackend::new();
        let sysproxy = Arc::new(SystemProxyManager::with_backend(&tmp_dir, backend.clone()));

        let controller =
            ProxyEngineController::new_for_test(ca, rules, filters, store, sysproxy).unwrap();
        (controller, backend, tmp_dir)
    }

    #[tokio::test]
    async fn doctor_detects_stopped_port_and_fixes_listener_plus_e2e_health() {
        let (controller, _backend, tmp_dir) = make_test_controller("stopped_and_e2e");

        // Start & stop once on an OS-assigned free port so controller remembers `test_port` in stopped state
        let started = controller
            .start("127.0.0.1".to_string(), 0)
            .await
            .unwrap();
        assert!(started.running);
        let test_port = started.port;
        assert!(test_port > 0);
        let stopped = controller.stop().await;
        assert!(!stopped.running);
        assert_eq!(stopped.port, test_port);

        // 1. When stopped with free port: port_binding = warning (fixable), loopback_e2e = error (fixable)
        let checks = run_proxy_doctor(&controller).await;
        assert_eq!(checks.len(), 6);
        let port_check = checks.iter().find(|c| c.id == "port_binding").unwrap();
        assert_eq!(port_check.status, "warning");
        assert!(port_check.can_auto_fix);

        let e2e_check = checks.iter().find(|c| c.id == "loopback_e2e").unwrap();
        assert_eq!(e2e_check.status, "error");
        assert!(e2e_check.can_auto_fix);

        // 2. Auto-fix `port_binding` starts the listener and makes both port_binding & loopback_e2e OK
        let fixed_checks = fix_doctor_issue(&controller, "port_binding")
            .await
            .expect("fix_doctor_issue(port_binding) must start listener");
        let port_after = fixed_checks.iter().find(|c| c.id == "port_binding").unwrap();
        assert_eq!(port_after.status, "ok");
        assert!(!port_after.can_auto_fix);

        let e2e_after = fixed_checks.iter().find(|c| c.id == "loopback_e2e").unwrap();
        assert_eq!(e2e_after.status, "ok");
        assert!(e2e_after.summary.contains("HTTP 200"));

        // Verify /health probe did NOT create noisy sessions in TrafficStore
        assert_eq!(
            controller.context.store.len(),
            0,
            "GET http://flux.proxy/health must not record noisy sessions in TrafficStore"
        );

        let _ = controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn doctor_detects_occupied_port_and_recovers_on_fix() {
        let (controller, _backend, tmp_dir) = make_test_controller("occupied_port");

        // External process occupies `conflict_port` continuously (eliminates drop-and-rebind race)
        let blocker = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let conflict_port = blocker.local_addr().unwrap().port();

        let configured = controller.set_port(conflict_port).await.unwrap();
        assert!(!configured.running);
        assert_eq!(configured.port, conflict_port);

        let port_check = check_port_binding(&controller.status().await).await;
        assert_eq!(port_check.status, "error");
        assert!(port_check.can_auto_fix);
        assert!(port_check.details.contains("AddrInUse"));

        // Fix falls back to another free port and succeeds
        let after = fix_doctor_issue(&controller, "port_binding")
            .await
            .expect("should recover by binding fallback port");
        let port_after = after.iter().find(|c| c.id == "port_binding").unwrap();
        assert_eq!(port_after.status, "ok");
        assert!(controller.status().await.running);
        assert_ne!(controller.status().await.port, conflict_port);

        drop(blocker);
        let _ = controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn doctor_detects_and_repairs_system_proxy_hijack() {
        let (controller, backend, tmp_dir) = make_test_controller("sysproxy_hijack");

        controller
            .start("127.0.0.1".to_string(), 0)
            .await
            .unwrap();

        // Initially synchronized
        let initial_check = evaluate_system_proxy_sync(&controller, &controller.status().await);
        assert_eq!(initial_check.status, "ok");

        // External VPN/app hijacks OS system proxy to another endpoint
        backend.set_external_hijack(Some("127.0.0.1:10809"));
        let hijacked_check = evaluate_system_proxy_sync(&controller, &controller.status().await);
        assert_eq!(hijacked_check.status, "error");
        assert!(hijacked_check.can_auto_fix);
        assert!(hijacked_check.details.contains("127.0.0.1:10809"));

        // 1-click fix restores system proxy back to FluxProxy
        let fixed = fix_doctor_issue(&controller, "system_proxy_sync")
            .await
            .expect("fix system_proxy_sync should restore proxy");
        let fixed_sys = fixed.iter().find(|c| c.id == "system_proxy_sync").unwrap();
        assert_eq!(fixed_sys.status, "ok");
        assert!(!fixed_sys.can_auto_fix);

        let _ = controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn evaluates_vpn_cgnat_and_firewall_heuristics() {
        let clean = vec![NetworkInterfaceInfo {
            name: "Wi-Fi".into(),
            ip: "192.168.1.45".into(),
            kind: "wifi".into(),
            is_primary: true,
        }];
        let vpn_ok = evaluate_vpn_interfaces(&clean, Some(Ipv4Addr::new(192, 168, 1, 45)));
        assert_eq!(vpn_ok.status, "ok");

        let with_vpn = vec![
            NetworkInterfaceInfo {
                name: "Wi-Fi".into(),
                ip: "192.168.1.45".into(),
                kind: "wifi".into(),
                is_primary: true,
            },
            NetworkInterfaceInfo {
                name: "Tailscale".into(),
                ip: "100.101.102.4".into(),
                kind: "vpn".into(),
                is_primary: false,
            },
        ];
        let vpn_warn = evaluate_vpn_interfaces(&with_vpn, Some(Ipv4Addr::new(100, 101, 102, 4)));
        assert_eq!(vpn_warn.status, "warning");
        assert!(vpn_warn.summary.contains("Tailscale"));
        assert!(vpn_warn.details.contains("TUN"));

        let lan_status = ProxyStatus {
            running: true,
            bind_addr: "0.0.0.0".into(),
            port: 8888,
            active_sessions: 0,
            system_proxy_enabled: true,
            auto_system_proxy: true,
            system_proxy_error: None,
            allow_remote: true,
            bind_mode: BindHostMode::AllInterfaces,
            specific_bind_ip: None,
            also_bind_loopback: true,
            bound_ips: vec!["0.0.0.0".into()],
        };
        let fw_warn = evaluate_firewall_result(
            &lan_status,
            Some(Ok(())),
            &FirewallInspection {
                inspected: true,
                any_profile_enabled: true,
                blocks_inbound_by_default: true,
                active_profiles_summary: "Private=ON(BlockInbound)".into(),
                has_flux_allow_rule: Some(false),
            },
        );
        assert_eq!(fw_warn.status, "warning");

        let fw_ok = evaluate_firewall_result(
            &lan_status,
            Some(Ok(())),
            &FirewallInspection {
                inspected: true,
                any_profile_enabled: true,
                blocks_inbound_by_default: true,
                active_profiles_summary: "Private=ON(BlockInbound)".into(),
                has_flux_allow_rule: Some(true),
            },
        );
        assert_eq!(fw_ok.status, "ok");
    }
}
