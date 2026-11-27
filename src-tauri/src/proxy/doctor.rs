use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

use crate::models::{BindHostMode, DoctorCheckResult, NetworkInterfaceInfo, ProxyError, ProxyStatus};
use crate::proxy::network::{
    detect_primary_outbound_ipv4, is_cgnat_or_vpn_ipv4, list_network_interfaces_with_options,
};
use crate::proxy::server::{
    bind_listeners_with_cleanup, format_bind_sock_addr, resolve_bind_plan, ProxyEngineController,
};
use crate::proxy::sysproxy::resolve_sysproxy_host_for_bind;
use crate::proxy::upstream_client::extract_peer_cert_subject_issuer;

const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const TCP_REACHABILITY_TIMEOUT: Duration = Duration::from_millis(600);
const WIN32_ERROR_SUCCESS: u32 = 0;
const WIN32_ERROR_MORE_DATA: u32 = 234;
const WIN32_REG_SZ: u32 = 1;
const MAX_FIREWALL_RULE_NAME_CHARS: usize = 16_384;
const MAX_FIREWALL_RULE_DATA_BYTES: usize = 1024 * 1024;
const MAX_FIREWALL_RULE_ENTRIES: u32 = 8192;

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
            suggested_command: None,
        };
    }

    let retry_attempts = if status.running { 6 } else { 3 };
    match bind_listeners_with_cleanup(&target_ips, status.port, retry_attempts).await {
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
                suggested_command: None,
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
            suggested_command: None,
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
                    suggested_command: None,
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
                    suggested_command: info.manual_install_command,
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
            suggested_command: None,
        },
    }
}

pub(crate) fn read_windows_gpo_proxy_settings_per_user() -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        win_reg::open_hklm(
            "Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        )
        .and_then(|guard| win_reg::query_dword(guard.0, "ProxySettingsPerUser"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn extract_export_proxy_command(err_msg: &str) -> Option<String> {
    let idx = err_msg.find("export HTTP_PROXY=")?;
    let tail = &err_msg[idx..];
    let cmd = tail.lines().next().unwrap_or(tail).trim();
    if cmd.is_empty() {
        None
    } else {
        Some(cmd.to_string())
    }
}

pub(crate) fn evaluate_system_proxy_sync(
    controller: &ProxyEngineController,
    status: &ProxyStatus,
) -> DoctorCheckResult {
    evaluate_system_proxy_sync_with_policy(
        controller,
        status,
        read_windows_gpo_proxy_settings_per_user(),
    )
}

pub(crate) fn evaluate_system_proxy_sync_with_policy(
    controller: &ProxyEngineController,
    status: &ProxyStatus,
    gpo_proxy_settings_per_user: Option<u32>,
) -> DoctorCheckResult {
    let expected_host = resolve_sysproxy_host_for_bind(
        status.bind_mode,
        status.specific_bind_ip.as_deref(),
        status.also_bind_loopback,
    );
    let expected_endpoint = format_bind_sock_addr(&expected_host, status.port);

    if gpo_proxy_settings_per_user == Some(0) {
        let browser_cmd = format!("chrome --proxy-server=http://{expected_endpoint}");
        return DoctorCheckResult {
            id: "system_proxy_sync".to_string(),
            title: "Синхронизация системного прокси ОС".to_string(),
            status: "error".to_string(),
            summary: "Системный прокси заблокирован политикой организации (GPO)".to_string(),
            details: format!(
                "В реестре Windows установлен запрет HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\ProxySettingsPerUser = 0 (настройки прокси задаются только на уровне машины/администратора; FluxProxy не пытается обходить политику через UAC).\nЗапустите отдельный экземпляр браузера с флагом прокси:\n  {browser_cmd}\n  msedge --proxy-server=http://{expected_endpoint}"
            ),
            can_auto_fix: false,
            fix_label: None,
            suggested_command: Some(browser_cmd),
        };
    }

    let (sys_enabled, sys_err) = controller
        .sysproxy
        .status_for_listener(&expected_host, status.port);

    if let Some(err_msg) = sys_err.or_else(|| status.system_proxy_error.clone()) {
        if let Some(export_cmd) = extract_export_proxy_command(&err_msg) {
            return DoctorCheckResult {
                id: "system_proxy_sync".to_string(),
                title: "Синхронизация системного прокси ОС".to_string(),
                status: "warning".to_string(),
                summary: format!(
                    "Окружение Linux без DE: настройте HTTP_PROXY/HTTPS_PROXY вручную на {expected_endpoint}"
                ),
                details: err_msg,
                can_auto_fix: false,
                fix_label: None,
                suggested_command: Some(export_cmd),
            };
        }
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
            suggested_command: None,
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
            suggested_command: None,
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
            suggested_command: None,
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
            suggested_command: None,
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
        suggested_command: None,
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
            suggested_command: None,
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
        suggested_command: None,
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
            suggested_command: None,
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
            suggested_command: None,
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
            suggested_command: None,
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
                suggested_command: None,
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
                suggested_command: None,
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
            suggested_command: Some(fix_cmd),
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
        suggested_command: Some(fix_cmd),
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn scan_firewall_rules_with_enumerator<F>(port: u16, mut enumerate: F) -> bool
where
    F: FnMut(u32, &mut [u16], &mut u32, &mut u32, &mut [u8], &mut u32) -> u32,
{
    let port_token = format!("lport={port}");
    let mut idx: u32 = 0;
    let mut retries_for_idx: u8 = 0;
    let mut name_buf = vec![0u16; 512];
    let mut data_buf = vec![0u8; 4096];

    loop {
        if idx >= MAX_FIREWALL_RULE_ENTRIES {
            break;
        }
        let mut name_len = name_buf.len() as u32;
        let mut data_len = data_buf.len() as u32;
        let mut reg_type: u32 = 0;
        let rc = enumerate(
            idx,
            &mut name_buf,
            &mut name_len,
            &mut reg_type,
            &mut data_buf,
            &mut data_len,
        );
        if rc == WIN32_ERROR_MORE_DATA {
            retries_for_idx = retries_for_idx.saturating_add(1);
            if retries_for_idx > 8 {
                idx += 1;
                retries_for_idx = 0;
                continue;
            }
            let mut grew = false;
            let needed_data = (data_len as usize).saturating_add(2);
            if needed_data > data_buf.len() && data_buf.len() < MAX_FIREWALL_RULE_DATA_BYTES {
                let target_len = needed_data
                    .max(data_buf.len().saturating_mul(2))
                    .min(MAX_FIREWALL_RULE_DATA_BYTES);
                if target_len > data_buf.len() {
                    data_buf.resize(target_len, 0);
                    grew = true;
                }
            }
            let needed_name = (name_len as usize).saturating_add(1);
            if (!grew
                || needed_name > name_buf.len()
                || (name_len as usize) >= name_buf.len().saturating_sub(1))
                && name_buf.len() < MAX_FIREWALL_RULE_NAME_CHARS
            {
                let target_name_len = needed_name
                    .max(name_buf.len().saturating_mul(2))
                    .min(MAX_FIREWALL_RULE_NAME_CHARS);
                if target_name_len > name_buf.len() {
                    name_buf.resize(target_name_len, 0);
                    grew = true;
                }
            }
            if !grew {
                idx += 1;
                retries_for_idx = 0;
            }
            continue;
        }
        if rc != WIN32_ERROR_SUCCESS {
            break;
        }
        retries_for_idx = 0;
        idx += 1;

        if reg_type == WIN32_REG_SZ && data_len >= 2 {
            let wide_slice: Vec<u16> = data_buf[..(data_len as usize).min(data_buf.len())]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&p| u16::from_le_bytes(p))
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
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
mod win_reg {
    use std::ffi::c_void;
    use std::ptr::null_mut;

    pub type HKey = *mut c_void;
    pub const HKEY_LOCAL_MACHINE: HKey = (0x8000_0002u32 as i32 as isize) as HKey;
    pub const KEY_QUERY_VALUE: u32 = 0x0001;
    pub const REG_DWORD: u32 = 4;
    pub const ERROR_SUCCESS: u32 = 0;

    #[link(name = "advapi32")]
    extern "system" {
        pub fn RegOpenKeyExW(
            h_key: HKey,
            lp_sub_key: *const u16,
            ul_options: u32,
            sam_desired: u32,
            phk_result: *mut HKey,
        ) -> u32;
        pub fn RegQueryValueExW(
            h_key: HKey,
            lp_value_name: *const u16,
            lp_reserved: *mut u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> u32;
        pub fn RegEnumValueW(
            h_key: HKey,
            dw_index: u32,
            lp_value_name: *mut u16,
            lpcch_value_name: *mut u32,
            lp_reserved: *mut u32,
            lp_type: *mut u32,
            lp_data: *mut u8,
            lpcb_data: *mut u32,
        ) -> u32;
        pub fn RegCloseKey(h_key: HKey) -> u32;
    }

    pub struct KeyGuard(pub HKey);
    impl Drop for KeyGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = RegCloseKey(self.0);
                }
            }
        }
    }

    pub fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn open_hklm(subkey: &str) -> Option<KeyGuard> {
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

    pub fn query_dword(hkey: HKey, name: &str) -> Option<u32> {
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
}

#[cfg(target_os = "windows")]
fn inspect_os_firewall_non_privileged(port: u16) -> FirewallInspection {
    use std::ptr::null_mut;

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
        if let Some(guard) = win_reg::open_hklm(key_path) {
            inspected = true;
            let enabled = win_reg::query_dword(guard.0, "EnableFirewall").unwrap_or(1) != 0;
            let def_inbound_block =
                win_reg::query_dword(guard.0, "DefaultInboundAction").unwrap_or(1) != 0;
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

    let mut has_allow_rule = None;
    if let Some(rules_guard) = win_reg::open_hklm(
        "SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules",
    ) {
        let found = scan_firewall_rules_with_enumerator(
            port,
            |idx, name_buf, name_len, reg_type, data_buf, data_len| unsafe {
                win_reg::RegEnumValueW(
                    rules_guard.0,
                    idx,
                    name_buf.as_mut_ptr(),
                    name_len,
                    null_mut(),
                    reg_type,
                    data_buf.as_mut_ptr(),
                    data_len,
                )
            },
        );
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HttpsProbeOutcome {
    Verified {
        status_code: u16,
        elapsed_ms: u64,
        local_ca_sha256: String,
        peer_sha256: Option<String>,
    },
    CertMismatch {
        peer_sha256: String,
        peer_subject: Option<String>,
        peer_issuer: Option<String>,
        detected_inspector: Option<String>,
        local_ca_sha256: String,
        reason: String,
    },
    TransportError(String),
}

#[derive(Debug, Clone)]
struct CapturedProbeCert {
    sha256: String,
    subject: Option<String>,
    issuer: Option<String>,
    verified_by_local_ca: bool,
}

fn format_der_sha256_colon(der: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(der);
    let digest = hex::encode_upper(hasher.finalize());
    digest
        .as_bytes()
        .chunks(2)
        .map(|c| std::str::from_utf8(c).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(":")
}

pub(crate) fn detect_external_ssl_inspector(
    subject: Option<&str>,
    issuer: Option<&str>,
) -> Option<&'static str> {
    let combined = format!(
        "{} {}",
        subject.unwrap_or_default(),
        issuer.unwrap_or_default()
    )
    .to_ascii_lowercase();
    if combined.contains("zscaler") {
        Some("Zscaler")
    } else if combined.contains("kaspersky") {
        Some("Kaspersky")
    } else if combined.contains("netskope") {
        Some("Netskope")
    } else if combined.contains("fortinet") || combined.contains("fortigate") {
        Some("Fortinet / FortiGate")
    } else if combined.contains("palo alto") {
        Some("Palo Alto Networks")
    } else if combined.contains("crowdstrike") {
        Some("CrowdStrike EDR")
    } else if combined.contains("sentinelone") {
        Some("SentinelOne EDR")
    } else if combined.contains("sophos") {
        Some("Sophos")
    } else if combined.contains("eset") {
        Some("ESET")
    } else if combined.contains("bitdefender") {
        Some("Bitdefender")
    } else if combined.contains("trellix") || combined.contains("mcafee") {
        Some("Trellix / McAfee")
    } else if combined.contains("cisco umbrella") {
        Some("Cisco Umbrella")
    } else if combined.contains("forcepoint") {
        Some("Forcepoint")
    } else if combined.contains("symantec") || combined.contains("blue coat") {
        Some("Symantec / Blue Coat")
    } else if combined.contains("checkpoint") || combined.contains("check point") {
        Some("Check Point")
    } else if combined.contains("defender") {
        Some("Microsoft Defender / EDR")
    } else {
        None
    }
}

#[derive(Debug)]
struct LocalCaInspectingVerifier {
    inner: Arc<dyn ServerCertVerifier>,
    captured: Arc<StdMutex<Option<CapturedProbeCert>>>,
}

impl ServerCertVerifier for LocalCaInspectingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let sha256 = format_der_sha256_colon(end_entity.as_ref());
        let (subject, issuer) = extract_peer_cert_subject_issuer(end_entity.as_ref());
        let res = self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        );
        if let Ok(mut guard) = self.captured.lock() {
            *guard = Some(CapturedProbeCert {
                sha256,
                subject,
                issuer,
                verified_by_local_ca: res.is_ok(),
            });
        }
        res
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

async fn read_http_head_from_stream(
    stream: &mut TcpStream,
    probe_addr: &str,
) -> Result<(u16, String), String> {
    let mut head = Vec::with_capacity(512);
    let mut byte = [0u8; 1];
    loop {
        if head.len() >= 8192 {
            return Err(format!("Слишком длинный заголовок CONNECT от {probe_addr}"));
        }
        match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, stream.read_exact(&mut byte)).await {
            Ok(Ok(_)) => {
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            Ok(Err(err)) => {
                return Err(format!("Ошибка чтения CONNECT-ответа от {probe_addr}: {err}"));
            }
            Err(_) => {
                return Err(format!("Таймаут ожидания CONNECT-ответа от {probe_addr}"));
            }
        }
    }
    let text = String::from_utf8_lossy(&head);
    let status_line = text.split("\r\n").next().unwrap_or("");
    let code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| format!("Некорректный CONNECT-ответ от {probe_addr}: '{status_line}'"))?;
    Ok((code, status_line.to_string()))
}

pub(crate) async fn probe_proxy_https_health_endpoint(
    probe_addr: &str,
    local_ca_der: &[u8],
    local_ca_sha256: &str,
) -> HttpsProbeOutcome {
    let started = Instant::now();
    let mut root_store = rustls::RootCertStore::empty();
    if let Err(err) = root_store.add(CertificateDer::from(local_ca_der.to_vec())) {
        return HttpsProbeOutcome::TransportError(format!(
            "Не удалось загрузить локальный Root CA в тестовый RootCertStore: {err}"
        ));
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let inner_verifier = match rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(root_store),
        Arc::clone(&provider),
    )
    .build()
    {
        Ok(v) => v,
        Err(err) => {
            return HttpsProbeOutcome::TransportError(format!(
                "Ошибка инициализации WebPkiServerVerifier для HTTPS-пробы: {err}"
            ));
        }
    };

    let captured: Arc<StdMutex<Option<CapturedProbeCert>>> = Arc::new(StdMutex::new(None));
    let inspecting_verifier = Arc::new(LocalCaInspectingVerifier {
        inner: inner_verifier,
        captured: Arc::clone(&captured),
    });

    let tls_config = match rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
    {
        Ok(builder) => builder
            .dangerous()
            .with_custom_certificate_verifier(inspecting_verifier)
            .with_no_client_auth(),
        Err(err) => {
            return HttpsProbeOutcome::TransportError(format!(
                "Ошибка настройки TLS ClientConfig для HTTPS-пробы: {err}"
            ));
        }
    };

    let mut tcp = match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, TcpStream::connect(probe_addr)).await {
        Ok(Ok(s)) => s,
        Ok(Err(err)) => {
            return HttpsProbeOutcome::TransportError(format!(
                "TCP-подключение для HTTPS-пробы к {probe_addr} не удалось: {err}"
            ));
        }
        Err(_) => {
            return HttpsProbeOutcome::TransportError(format!(
                "Таймаут TCP-подключения для HTTPS-пробы к {probe_addr}"
            ));
        }
    };

    let connect_req = b"CONNECT flux.proxy:443 HTTP/1.1\r\nHost: flux.proxy:443\r\nUser-Agent: FluxProxy-Doctor/1.0\r\n\r\n";
    if let Err(err) = tokio::time::timeout(HEALTH_PROBE_TIMEOUT, tcp.write_all(connect_req)).await {
        return HttpsProbeOutcome::TransportError(format!(
            "Ошибка отправки CONNECT flux.proxy:443 на {probe_addr}: {err}"
        ));
    }

    match read_http_head_from_stream(&mut tcp, probe_addr).await {
        Ok((200, _)) => {}
        Ok((code, line)) => {
            return HttpsProbeOutcome::TransportError(format!(
                "CONNECT flux.proxy:443 вернул HTTP {code} ({line})"
            ));
        }
        Err(err) => return HttpsProbeOutcome::TransportError(err),
    }

    let server_name = match ServerName::try_from("flux.proxy") {
        Ok(sn) => sn,
        Err(err) => {
            return HttpsProbeOutcome::TransportError(format!("Некорректный SNI flux.proxy: {err}"));
        }
    };

    let connector = TlsConnector::from(Arc::new(tls_config));
    let mut tls_stream =
        match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, connector.connect(server_name, tcp)).await {
            Ok(Ok(s)) => s,
            Ok(Err(err)) => {
                let maybe_cert = captured.lock().ok().and_then(|g| g.clone());
                if let Some(cert) = maybe_cert {
                    if !cert.verified_by_local_ca {
                        let detected_inspector = detect_external_ssl_inspector(
                            cert.subject.as_deref(),
                            cert.issuer.as_deref(),
                        )
                        .map(str::to_string);
                        return HttpsProbeOutcome::CertMismatch {
                            peer_sha256: cert.sha256,
                            peer_subject: cert.subject,
                            peer_issuer: cert.issuer,
                            detected_inspector,
                            local_ca_sha256: local_ca_sha256.to_string(),
                            reason: err.to_string(),
                        };
                    }
                }
                return HttpsProbeOutcome::TransportError(format!(
                    "TLS-рукопожатие HTTPS-пробы с {probe_addr} завершилось ошибкой: {err}"
                ));
            }
            Err(_) => {
                return HttpsProbeOutcome::TransportError(format!(
                    "Таймаут TLS-рукопожатия HTTPS-пробы с {probe_addr}"
                ));
            }
        };

    let https_req = b"GET /health HTTP/1.1\r\nHost: flux.proxy\r\nConnection: close\r\nUser-Agent: FluxProxy-Doctor/1.0\r\n\r\n";
    if let Err(err) = tokio::time::timeout(HEALTH_PROBE_TIMEOUT, tls_stream.write_all(https_req)).await {
        return HttpsProbeOutcome::TransportError(format!(
            "Ошибка отправки HTTPS GET /health: {err}"
        ));
    }

    let mut raw = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    loop {
        if raw.len() >= 16 * 1024 {
            break;
        }
        match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, tls_stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => raw.extend_from_slice(&buf[..n]),
            Ok(Err(err)) => {
                return HttpsProbeOutcome::TransportError(format!(
                    "Ошибка чтения HTTPS /health ответа: {err}"
                ));
            }
            Err(_) => {
                return HttpsProbeOutcome::TransportError(
                    "Таймаут чтения HTTPS /health ответа".to_string(),
                );
            }
        }
    }

    let text = String::from_utf8_lossy(&raw);
    let status_line = text.split("\r\n").next().unwrap_or("");
    let Some(status_code) = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
    else {
        return HttpsProbeOutcome::TransportError(format!(
            "Некорректный HTTPS-ответ от {probe_addr}: '{status_line}'"
        ));
    };
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.trim().to_string())
        .unwrap_or_default();
    if status_code != 200 || !body.contains("\"ok\"") {
        return HttpsProbeOutcome::TransportError(format!(
            "Неожиданный HTTPS /health ответ: HTTP {status_code} ({body})"
        ));
    }

    let peer_sha256 = captured.lock().ok().and_then(|g| g.as_ref().map(|c| c.sha256.clone()));
    HttpsProbeOutcome::Verified {
        status_code,
        elapsed_ms: started.elapsed().as_millis() as u64,
        local_ca_sha256: local_ca_sha256.to_string(),
        peer_sha256,
    }
}

pub(crate) fn evaluate_loopback_e2e_result(
    probe_addr: &str,
    http_res: Result<(u16, String, u64), String>,
    https_res: Option<HttpsProbeOutcome>,
) -> DoctorCheckResult {
    match http_res {
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
            suggested_command: None,
        },
        Ok((code, body, elapsed_ms)) => match https_res {
            Some(HttpsProbeOutcome::Verified {
                elapsed_ms: https_ms,
                local_ca_sha256,
                peer_sha256,
                ..
            }) => DoctorCheckResult {
                id: "loopback_e2e".to_string(),
                title: "End-to-End loopback-маршрутизация (/health)".to_string(),
                status: "ok".to_string(),
                summary: format!(
                    "HTTP/HTTPS /health → HTTP {code} ({elapsed_ms} мс / TLS {https_ms} мс), Root CA подтверждён"
                ),
                details: format!(
                    "Локальный сокет {probe_addr} обработал HTTP ({body}) и HTTPS MITM /health без записи в TrafficStore.\nЛокальный Root CA SHA-256: {local_ca_sha256}{}",
                    peer_sha256
                        .map(|fp| format!("\nЛистовой сертификат (SHA-256): {fp}"))
                        .unwrap_or_default()
                ),
                can_auto_fix: false,
                fix_label: None,
                suggested_command: None,
            },
            Some(HttpsProbeOutcome::CertMismatch {
                peer_sha256,
                peer_subject,
                peer_issuer,
                detected_inspector,
                local_ca_sha256,
                reason,
            }) => {
                let vendor_label = detected_inspector
                    .as_deref()
                    .map(|v| format!(" ({v})"))
                    .unwrap_or_else(|| " (Zscaler / Kaspersky / EDR)".to_string());
                DoctorCheckResult {
                    id: "loopback_e2e".to_string(),
                    title: "End-to-End loopback-маршрутизация (/health)".to_string(),
                    status: "warning".to_string(),
                    summary: format!(
                        "Обнаружен внешний SSL-инспектор{vendor_label}: отпечаток HTTPS-пробы не совпадает с локальным Root CA"
                    ),
                    details: format!(
                        "HTTP-проба http://flux.proxy/health прошла ({code}, {elapsed_ms} мс), но TLS-сертификат в HTTPS-пробе НЕ подписан локальным Root CA FluxProxy.\nВероятная причина: сторонний корпоративный прокси/антивирус/WFP-драйвер (Zscaler, Kaspersky, EDR) перехватывает и переподписывает локальный TLS-трафик.\nОжидаемый Root CA SHA-256: {local_ca_sha256}\nПолученный сертификат SHA-256: {peer_sha256}\nSubject: {}\nIssuer: {}\nОшибка проверки: {reason}\nРекомендация: добавьте 127.0.0.1 / flux.proxy и процесс FluxProxy в исключения SSL-сканирования вашего EDR/антивируса.",
                        peer_subject.unwrap_or_else(|| "<неизвестно>".to_string()),
                        peer_issuer.unwrap_or_else(|| "<неизвестно>".to_string()),
                    ),
                    can_auto_fix: false,
                    fix_label: None,
                    suggested_command: None,
                }
            }
            Some(HttpsProbeOutcome::TransportError(tls_err)) => DoctorCheckResult {
                id: "loopback_e2e".to_string(),
                title: "End-to-End loopback-маршрутизация (/health)".to_string(),
                status: "warning".to_string(),
                summary: format!(
                    "HTTP /health → HTTP {code} ({elapsed_ms} мс), но HTTPS-проба не завершилась"
                ),
                details: format!(
                    "HTTP-маршрут через {probe_addr} работает ({body}), однако TLS/HTTPS-самопроверка завершилась ошибкой: {tls_err}"
                ),
                can_auto_fix: false,
                fix_label: None,
                suggested_command: None,
            },
            None => DoctorCheckResult {
                id: "loopback_e2e".to_string(),
                title: "End-to-End loopback-маршрутизация (/health)".to_string(),
                status: "ok".to_string(),
                summary: format!("GET http://flux.proxy/health → HTTP {code} ({elapsed_ms} мс)"),
                details: format!(
                    "Локальный сокет {probe_addr} корректно обработал HTTP-запрос и вернул {body} без создания лишних сессий в TrafficStore."
                ),
                can_auto_fix: false,
                fix_label: None,
                suggested_command: None,
            },
        },
    }
}

async fn check_loopback_e2e(
    controller: &ProxyEngineController,
    status: &ProxyStatus,
) -> DoctorCheckResult {
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
            suggested_command: None,
        };
    }

    let http_res = probe_proxy_health_endpoint(&probe_addr).await;
    let https_res = if http_res.is_ok() {
        let local_ca_der = controller.context.ca.root_ca_der().to_vec();
        let local_ca_sha256 = controller.context.ca.info().sha256_fingerprint;
        Some(probe_proxy_https_health_endpoint(&probe_addr, &local_ca_der, &local_ca_sha256).await)
    } else {
        None
    };

    evaluate_loopback_e2e_result(&probe_addr, http_res, https_res)
}

pub async fn run_proxy_doctor(controller: &ProxyEngineController) -> Vec<DoctorCheckResult> {
    let status = controller.status().await;

    let port_check = check_port_binding(&status).await;
    let ca_check = check_root_ca_trust(controller).await;
    let sysproxy_check = evaluate_system_proxy_sync(controller, &status);
    let vpn_check = check_vpn_interfaces().await;
    let firewall_check = check_firewall(&status).await;
    let loopback_check = check_loopback_e2e(controller, &status).await;

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
                controller.save_persisted_proxy_port(started.port);
                return Ok(started);
            }
        }
    }

    let started = controller.start_with_config(0).await?;
    if started.port > 0 {
        controller.save_persisted_proxy_port(started.port);
    }
    Ok(started)
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
            if read_windows_gpo_proxy_settings_per_user() == Some(0) {
                let status = controller.status().await;
                let host = resolve_sysproxy_host_for_bind(
                    status.bind_mode,
                    status.specific_bind_ip.as_deref(),
                    status.also_bind_loopback,
                );
                let ep = format_bind_sock_addr(&host, status.port);
                return Err(ProxyError::Custom(format!(
                    "Системный прокси заблокирован политикой GPO (ProxySettingsPerUser = 0). Запустите браузер с --proxy-server=http://{ep}"
                )));
            }
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
            let gpo_blocked = read_windows_gpo_proxy_settings_per_user() == Some(0);
            let is_no_de_linux = sys_err
                .as_deref()
                .or(post_listener_status.system_proxy_error.as_deref())
                .is_some_and(|m| m.contains("export HTTP_PROXY="));
            if !gpo_blocked
                && !is_no_de_linux
                && (!sys_enabled
                    || sys_err.is_some()
                    || post_listener_status.system_proxy_error.is_some())
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

    #[test]
    fn firewall_scanner_resizes_buffers_on_error_more_data_and_finds_rule_after_large_entry() {
        let oversized_rule = format!(
            "v2.31|Action=Allow|Active=TRUE|Dir=In|LPort=5000|App={}|",
            "A".repeat(3000)
        );
        let oversized_wide: Vec<u16> = oversized_rule.encode_utf16().chain(std::iter::once(0)).collect();
        let oversized_bytes: Vec<u8> = oversized_wide.iter().flat_map(|u| u.to_le_bytes()).collect();
        assert!(oversized_bytes.len() > 4096);

        let long_name_chars: usize = 700;
        let long_name_rule = "v2.31|Action=Allow|Active=TRUE|Dir=In|LPort=6000|Name=Other|";
        let long_name_wide: Vec<u16> = long_name_rule.encode_utf16().chain(std::iter::once(0)).collect();
        let long_name_bytes: Vec<u8> = long_name_wide.iter().flat_map(|u| u.to_le_bytes()).collect();

        let flux_rule = "v2.31|Action=Allow|Active=TRUE|Dir=In|LPort=9443|Name=FluxProxy|";
        let flux_wide: Vec<u16> = flux_rule.encode_utf16().chain(std::iter::once(0)).collect();
        let flux_bytes: Vec<u8> = flux_wide.iter().flat_map(|u| u.to_le_bytes()).collect();

        let mut max_seen_data_buf = 0usize;
        let mut max_seen_name_buf = 0usize;

        let found = scan_firewall_rules_with_enumerator(
            9443,
            |idx, name_buf, name_len, reg_type, data_buf, data_len| {
                max_seen_data_buf = max_seen_data_buf.max(data_buf.len());
                max_seen_name_buf = max_seen_name_buf.max(name_buf.len());
                match idx {
                    0 => {
                        if data_buf.len() < oversized_bytes.len() {
                            *data_len = oversized_bytes.len() as u32;
                            *name_len = 8;
                            return WIN32_ERROR_MORE_DATA;
                        }
                        let name_u16: Vec<u16> = "BigRule".encode_utf16().chain(std::iter::once(0)).collect();
                        name_buf[..name_u16.len()].copy_from_slice(&name_u16);
                        *name_len = (name_u16.len() - 1) as u32;
                        data_buf[..oversized_bytes.len()].copy_from_slice(&oversized_bytes);
                        *data_len = oversized_bytes.len() as u32;
                        *reg_type = WIN32_REG_SZ;
                        WIN32_ERROR_SUCCESS
                    }
                    1 => {
                        if name_buf.len() <= long_name_chars {
                            *name_len = long_name_chars as u32;
                            *data_len = long_name_bytes.len() as u32;
                            return WIN32_ERROR_MORE_DATA;
                        }
                        for slot in name_buf[..long_name_chars].iter_mut() {
                            *slot = b'R' as u16;
                        }
                        name_buf[long_name_chars] = 0;
                        *name_len = long_name_chars as u32;
                        data_buf[..long_name_bytes.len()].copy_from_slice(&long_name_bytes);
                        *data_len = long_name_bytes.len() as u32;
                        *reg_type = WIN32_REG_SZ;
                        WIN32_ERROR_SUCCESS
                    }
                    2 => {
                        let name_u16: Vec<u16> = "FluxProxyRule".encode_utf16().chain(std::iter::once(0)).collect();
                        name_buf[..name_u16.len()].copy_from_slice(&name_u16);
                        *name_len = (name_u16.len() - 1) as u32;
                        data_buf[..flux_bytes.len()].copy_from_slice(&flux_bytes);
                        *data_len = flux_bytes.len() as u32;
                        *reg_type = WIN32_REG_SZ;
                        WIN32_ERROR_SUCCESS
                    }
                    _ => 259,
                }
            },
        );

        assert!(found, "must continue past oversized entries and detect FluxProxy rule");
        assert!(max_seen_data_buf >= oversized_bytes.len());
        assert!(max_seen_name_buf > long_name_chars);

        let not_found = scan_firewall_rules_with_enumerator(
            7777,
            |idx, name_buf, name_len, reg_type, data_buf, data_len| match idx {
                0 => {
                    if data_buf.len() < oversized_bytes.len() {
                        *data_len = oversized_bytes.len() as u32;
                        return WIN32_ERROR_MORE_DATA;
                    }
                    *name_len = 1;
                    name_buf[0] = b'X' as u16;
                    data_buf[..oversized_bytes.len()].copy_from_slice(&oversized_bytes);
                    *data_len = oversized_bytes.len() as u32;
                    *reg_type = WIN32_REG_SZ;
                    WIN32_ERROR_SUCCESS
                }
                _ => 259,
            },
        );
        assert!(!not_found);
    }

    #[tokio::test]
    async fn doctor_recovers_occupied_ports_and_persists_fallback_port() {
        let (controller, _backend, tmp_dir) = make_test_controller("persist_fallback_port");

        // Case A: desired port is occupied -> nearby port candidate+offset is chosen and persisted
        let blocker = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let conflict_port = blocker.local_addr().unwrap().port();
        controller.set_port(conflict_port).await.unwrap();
        assert_eq!(controller.sysproxy.load_proxy_port_pref(), conflict_port);

        let _ = fix_doctor_issue(&controller, "port_binding")
            .await
            .expect("nearby port fallback must succeed");
        let recovered_nearby = controller.status().await.port;
        assert_ne!(recovered_nearby, conflict_port);
        assert_eq!(controller.sysproxy.load_proxy_port_pref(), recovered_nearby);
        assert_eq!(
            std::fs::read_to_string(tmp_dir.join(crate::proxy::sysproxy::PROXY_PORT_PREF_FILE_NAME))
                .unwrap()
                .trim(),
            recovered_nearby.to_string()
        );
        let _ = controller.stop().await;
        drop(blocker);

        // Case B: all 11 ports desired..=desired+10 are occupied -> ephemeral `:0` port is persisted
        let mut range_blockers = Vec::new();
        let mut base_port = None;
        for candidate in (44000u16..45500u16).step_by(15) {
            let mut held = Vec::new();
            let mut all_ok = true;
            for offset in 0..=10u16 {
                match TcpListener::bind(("127.0.0.1", candidate + offset)).await {
                    Ok(l) => held.push(l),
                    Err(_) => {
                        all_ok = false;
                        break;
                    }
                }
            }
            if all_ok {
                range_blockers = held;
                base_port = Some(candidate);
                break;
            }
        }
        if let Some(base) = base_port {
            controller.set_port(base).await.unwrap();
            let _ = fix_doctor_issue(&controller, "port_binding")
                .await
                .expect("ephemeral :0 fallback must succeed when base..=base+10 are busy");
            let ephemeral_port = controller.status().await.port;
            assert!(ephemeral_port > 0);
            assert!(!(base..=base + 10).contains(&ephemeral_port));
            assert_eq!(controller.sysproxy.load_proxy_port_pref(), ephemeral_port);
            drop(range_blockers);
            let _ = controller.stop().await;
        }

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn gpo_policy_blocks_per_user_proxy_and_suggests_browser_flag() {
        let (controller, _backend, tmp_dir) = make_test_controller("gpo_policy");
        let started = controller.start("127.0.0.1".to_string(), 0).await.unwrap();
        let expected_cmd = format!("chrome --proxy-server=http://127.0.0.1:{}", started.port);

        let blocked = evaluate_system_proxy_sync_with_policy(&controller, &started, Some(0));
        assert_eq!(blocked.status, "error");
        assert!(!blocked.can_auto_fix);
        assert!(blocked.fix_label.is_none());
        assert!(blocked.summary.contains("GPO"));
        assert!(blocked.details.contains("ProxySettingsPerUser = 0"));
        assert_eq!(blocked.suggested_command.as_deref(), Some(expected_cmd.as_str()));

        let allowed_one = evaluate_system_proxy_sync_with_policy(&controller, &started, Some(1));
        assert_eq!(allowed_one.status, "ok");
        assert!(allowed_one.suggested_command.is_none());

        let allowed_absent = evaluate_system_proxy_sync_with_policy(&controller, &started, None);
        assert_eq!(allowed_absent.status, "ok");

        let _ = controller.stop().await;
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[tokio::test]
    async fn https_self_probe_verifies_local_ca_and_detects_external_edr_inspector() {
        let (controller, _backend, tmp_dir) = make_test_controller("https_probe_edr");
        let started = controller.start("127.0.0.1".to_string(), 0).await.unwrap();
        let probe_addr = format!("127.0.0.1:{}", started.port);
        let local_der = controller.context.ca.root_ca_der().to_vec();
        let local_fp = controller.context.ca.info().sha256_fingerprint;

        // 1. Fresh CA self-probe succeeds without creating TrafficStore records
        let outcome = probe_proxy_https_health_endpoint(&probe_addr, &local_der, &local_fp).await;
        assert!(
            matches!(outcome, HttpsProbeOutcome::Verified { status_code: 200, .. }),
            "expected Verified HTTPS probe on fresh CA, got {outcome:?}"
        );
        assert_eq!(controller.context.store.len(), 0);
        let _ = controller.stop().await;

        // 2. Reloaded CA from disk also passes self-probe
        let reloaded_ca = Arc::new(CertificateAuthority::init_or_load(&tmp_dir).unwrap());
        let reloaded_rules = Arc::new(RuleEngine::new());
        let reloaded_filters = Arc::new(ProxyFilterEngine::new());
        let reloaded_store = Arc::new(TrafficStore::new(tmp_dir.join("doctor2.sqlite")).unwrap());
        let reloaded_sysproxy =
            Arc::new(SystemProxyManager::with_backend(&tmp_dir, MockOsProxyBackend::new()));
        let reloaded_controller = ProxyEngineController::new_for_test(
            reloaded_ca,
            reloaded_rules,
            reloaded_filters,
            reloaded_store,
            reloaded_sysproxy,
        )
        .unwrap();
        let reloaded_started = reloaded_controller
            .start("127.0.0.1".to_string(), 0)
            .await
            .unwrap();
        let reloaded_probe = format!("127.0.0.1:{}", reloaded_started.port);
        let reloaded_outcome = probe_proxy_https_health_endpoint(
            &reloaded_probe,
            reloaded_controller.context.ca.root_ca_der(),
            &reloaded_controller.context.ca.info().sha256_fingerprint,
        )
        .await;
        assert!(
            matches!(reloaded_outcome, HttpsProbeOutcome::Verified { status_code: 200, .. }),
            "expected Verified HTTPS probe on reloaded CA, got {reloaded_outcome:?}"
        );
        let _ = reloaded_controller.stop().await;

        // 3. Mock external SSL inspector ("Zscaler Root CA") triggers CertMismatch & EDR warning
        let mut edr_ca_params = rcgen::CertificateParams::default();
        edr_ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let mut edr_dn = rcgen::DistinguishedName::new();
        edr_dn.push(rcgen::DnType::CommonName, "Zscaler Intermediate Root CA");
        edr_ca_params.distinguished_name = edr_dn;
        let edr_ca_key = rcgen::KeyPair::generate().unwrap();
        let edr_ca_cert = edr_ca_params.self_signed(&edr_ca_key).unwrap();

        let mut edr_leaf_params =
            rcgen::CertificateParams::new(vec!["flux.proxy".to_string()]).unwrap();
        edr_leaf_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let edr_leaf_key = rcgen::KeyPair::generate().unwrap();
        let edr_leaf_cert = edr_leaf_params
            .signed_by(&edr_leaf_key, &edr_ca_cert, &edr_ca_key)
            .unwrap();
        let edr_leaf_der = edr_leaf_cert.der().to_vec();
        let edr_leaf_fp = format_der_sha256_colon(&edr_leaf_der);

        let edr_tls_cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(edr_leaf_der)],
            rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
                edr_leaf_key.serialize_der(),
            )),
        )
        .unwrap();

        let mock_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = mock_listener.local_addr().unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(edr_tls_cfg));
        let server_task = tokio::spawn(async move {
            if let Ok((mut tcp, _)) = mock_listener.accept().await {
                let mut req_buf = [0u8; 512];
                let _ = tcp.read(&mut req_buf).await;
                let _ = tcp
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await;
                let _ = acceptor.accept(tcp).await;
            }
        });

        let edr_outcome = probe_proxy_https_health_endpoint(
            &mock_addr.to_string(),
            &local_der,
            &local_fp,
        )
        .await;
        let _ = server_task.await;

        match &edr_outcome {
            HttpsProbeOutcome::CertMismatch {
                peer_sha256,
                detected_inspector,
                ..
            } => {
                assert_eq!(peer_sha256, &edr_leaf_fp);
                assert_eq!(detected_inspector.as_deref(), Some("Zscaler"));
            }
            other => panic!("expected CertMismatch for Zscaler MITM cert, got {other:?}"),
        }

        let check = evaluate_loopback_e2e_result(
            &mock_addr.to_string(),
            Ok((200, "{\"status\":\"ok\"}".to_string(), 1)),
            Some(edr_outcome),
        );
        assert_eq!(check.status, "warning");
        assert!(!check.can_auto_fix);
        assert!(check.summary.contains("Zscaler"));
        assert!(check.details.contains(&local_fp));
        assert!(check.details.contains(&edr_leaf_fp));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
