use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use chrono::{DateTime, SecondsFormat, Utc};
use moka::sync::Cache;
use serde::{Deserialize, Serialize};
use x509_parser::extensions::GeneralName;

use crate::models::ProxyError;
use crate::proxy::server::build_upstream_client_with_identity;

const CLIENT_CERTS_DIR_NAME: &str = "client_certs";
const REGISTRY_FILE_NAME: &str = "registry.json";
const MAX_CERT_FILE_BYTES: u64 = 10 * 1024 * 1024; // 10 MiB safety limit
const CLIENT_CACHE_CAPACITY: u64 = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientCertificateFormat {
    Pkcs12,
    Pem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCertificateEntry {
    pub id: String,
    pub domain_pattern: String,
    pub label: String,
    pub format: ClientCertificateFormat,
    pub stored_cert_path: String,
    pub common_name: String,
    pub expires_at: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddClientCertificateRequest {
    pub domain_pattern: String,
    #[serde(default)]
    pub label: Option<String>,
    pub cert_path: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct ParsedClientCertificate {
    pub common_name: String,
    pub expires_at: String,
    pub identity_pem_bytes: Vec<u8>,
}

fn ensure_secure_dir(dir: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_bytes_securely(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        fs::write(path, contents)
    }
}

fn enforce_secure_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn strip_scheme_and_path(raw: &str) -> &str {
    let mut s = raw.trim();
    for scheme in ["https://", "http://", "wss://", "ws://"] {
        if s.len() >= scheme.len() && s[..scheme.len()].eq_ignore_ascii_case(scheme) {
            s = &s[scheme.len()..];
            break;
        }
    }
    if let Some((authority, _)) = s.split_once('/') {
        authority
    } else {
        s
    }
}

fn strip_optional_port(authority: &str) -> &str {
    let trimmed = authority.trim();
    if let Some(after_open) = trimmed.strip_prefix('[') {
        if let Some(close_idx) = after_open.find(']') {
            return &after_open[..close_idx];
        }
    }
    if trimmed.matches(':').count() == 1 {
        if let Some((host_part, port_part)) = trimmed.split_once(':') {
            if !port_part.is_empty() && port_part.chars().all(|c| c.is_ascii_digit()) {
                return host_part;
            }
        }
    }
    trimmed
}

/// Normalizes a domain mask (`api.corp.local`, `*.corp.local`, `https://api.corp.local:8443/v1`)
/// and validates wildcard syntax so invalid masks are rejected upfront.
pub fn normalize_domain_pattern(raw: &str) -> Result<String, ProxyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ProxyError::Custom(
            "Маска домена не может быть пустой.".into(),
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(ProxyError::Custom(
            "Маска домена не должна содержать пробелы.".into(),
        ));
    }

    let without_scheme = strip_scheme_and_path(trimmed);
    let host_only = strip_optional_port(without_scheme)
        .trim_end_matches('.')
        .to_ascii_lowercase();

    if host_only.is_empty() {
        return Err(ProxyError::Custom(
            "Некорректная маска домена: не удалось определить имя хоста.".into(),
        ));
    }
    if host_only == "*" || host_only == "*." {
        return Err(ProxyError::Custom(
            "Укажите конкретный домен или маску вида *.domain.com вместо '*'.".into(),
        ));
    }

    if let Some(suffix) = host_only.strip_prefix("*.") {
        if suffix.is_empty()
            || suffix.contains('*')
            || suffix.starts_with('.')
            || suffix.ends_with('.')
            || suffix.contains("..")
        {
            return Err(ProxyError::Custom(format!(
                "Некорректная wildcard-маска домена '{raw}'. Ожидается формат *.domain.com."
            )));
        }
    } else if host_only.contains('*') {
        return Err(ProxyError::Custom(format!(
            "Wildcard '*' допускается только в начале маски домена (например, *.{0}).",
            host_only.trim_start_matches('.').replace('*', "sub")
        )));
    } else if host_only.starts_with('.') || host_only.contains("..") {
        return Err(ProxyError::Custom(format!(
            "Некорректное имя домена '{raw}'."
        )));
    }

    Ok(host_only)
}

/// Normalizes an incoming target host (`API.Example.com:443`, `[::1]:8443`) for matching.
pub fn normalize_host_for_match(host: &str) -> String {
    let without_scheme = strip_scheme_and_path(host);
    strip_optional_port(without_scheme)
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Matches a normalized domain pattern against a target hostname.
/// `*.domain.com` strictly matches subdomains (e.g. `api.domain.com`, `v2.api.domain.com`),
/// NOT the apex `domain.com` and NOT `evildomain.com`.
pub fn domain_pattern_matches_host(pattern: &str, host: &str) -> bool {
    let norm_host = normalize_host_for_match(host);
    if norm_host.is_empty() {
        return false;
    }

    let norm_pattern = pattern
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if norm_pattern.is_empty() {
        return false;
    }

    if let Some(suffix) = norm_pattern.strip_prefix("*.") {
        if suffix.is_empty() || norm_host.len() <= suffix.len() + 1 {
            return false;
        }
        let Some(prefix_len) = norm_host.len().checked_sub(suffix.len()) else {
            return false;
        };
        norm_host.ends_with(suffix) && norm_host.as_bytes().get(prefix_len - 1) == Some(&b'.')
    } else {
        norm_host == norm_pattern
    }
}

fn match_specificity_rank(pattern: &str) -> (u8, usize) {
    let norm = pattern.trim().trim_end_matches('.');
    if let Some(suffix) = norm.strip_prefix("*.") {
        (1, suffix.len())
    } else {
        (2, norm.len())
    }
}

/// Extracts `Common Name (CN)` and RFC 3339 UTC `expires_at` timestamp from a DER-encoded X.509 certificate.
pub fn extract_x509_metadata(cert_der: &[u8]) -> Result<(String, String), ProxyError> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| ProxyError::Custom(format!("Не удалось разобрать X.509 сертификат: {e}")))?;

    let mut common_name = cert
        .subject()
        .iter_common_name()
        .filter_map(|attr| attr.as_str().ok())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_owned);

    if common_name.is_none() {
        if let Ok(Some(san_ext)) = cert.subject_alternative_name() {
            for gn in &san_ext.value.general_names {
                if let GeneralName::DNSName(dns) = gn {
                    let trimmed = dns.trim();
                    if !trimmed.is_empty() {
                        common_name = Some(trimmed.to_owned());
                        break;
                    }
                }
            }
        }
    }

    if common_name.is_none() {
        let subject_str = cert.subject().to_string();
        if !subject_str.trim().is_empty() {
            common_name = Some(subject_str);
        }
    }

    let cn = common_name.unwrap_or_else(|| "Unknown".to_string());
    let not_after_ts = cert.validity().not_after.timestamp();
    let expires_at = DateTime::<Utc>::from_timestamp(not_after_ts, 0)
        .ok_or_else(|| {
            ProxyError::Custom(format!(
                "Некорректная дата истечения сертификата (timestamp={not_after_ts})."
            ))
        })?
        .to_rfc3339_opts(SecondsFormat::Secs, true);

    Ok((cn, expires_at))
}

fn validate_identity_pem_with_reqwest(pem_bytes: &[u8]) -> Result<(), ProxyError> {
    let identity = reqwest::Identity::from_pem(pem_bytes).map_err(|e| {
        ProxyError::Custom(format!(
            "Не удалось сформировать TLS Identity из сертификата и ключа: {e}"
        ))
    })?;
    build_upstream_client_with_identity(false, Some(identity)).map_err(|e| {
        ProxyError::Custom(format!(
            "Сертификат и закрытый ключ не прошли проверку TLS-клиента (rustls): {e}"
        ))
    })?;
    Ok(())
}

/// Parses and validates a PKCS#12 (`.p12` / `.pfx`) archive in pure Rust,
/// returning X.509 metadata and a validated PEM identity bundle for `rustls`.
pub fn parse_pkcs12_identity(
    der_bytes: &[u8],
    password: &str,
) -> Result<ParsedClientCertificate, ProxyError> {
    if der_bytes.is_empty() {
        return Err(ProxyError::Custom("Файл PKCS#12 (.p12/.pfx) пуст.".into()));
    }

    let keystore = p12_keystore::KeyStore::from_pkcs12(der_bytes, password).map_err(|e| {
        ProxyError::Custom(format!(
            "Не удалось расшифровать PKCS#12 (.p12/.pfx). Проверьте пароль и формат файла: {e}"
        ))
    })?;

    let (_, key_chain) = keystore.private_key_chain().ok_or_else(|| {
        ProxyError::Custom(
            "В PKCS#12 архиве отсутствует закрытый ключ или связанная с ним цепочка сертификатов."
                .into(),
        )
    })?;

    if key_chain.key().is_empty() || key_chain.chain().is_empty() {
        return Err(ProxyError::Custom(
            "В PKCS#12 архиве отсутствуют данные ключа или клиентского сертификата.".into(),
        ));
    }

    let leaf_der = key_chain.chain()[0].as_der();
    let (common_name, expires_at) = extract_x509_metadata(leaf_der)?;

    let mut pem_text = String::new();
    for cert in key_chain.chain() {
        let block = pem::Pem::new("CERTIFICATE", cert.as_der().to_vec());
        pem_text.push_str(&pem::encode(&block));
    }
    let key_block = pem::Pem::new("PRIVATE KEY", key_chain.key().to_vec());
    pem_text.push_str(&pem::encode(&key_block));

    let identity_pem_bytes = pem_text.into_bytes();
    validate_identity_pem_with_reqwest(&identity_pem_bytes)?;

    Ok(ParsedClientCertificate {
        common_name,
        expires_at,
        identity_pem_bytes,
    })
}

fn is_supported_unencrypted_key_tag(tag: &str) -> bool {
    matches!(tag, "PRIVATE KEY" | "RSA PRIVATE KEY" | "EC PRIVATE KEY")
}

/// Parses and validates PEM certificate(s) and an unencrypted private key (either combined
/// in `cert_pem_bytes` or split across `cert_pem_bytes` and `key_pem_bytes`).
pub fn parse_pem_identity(
    cert_pem_bytes: &[u8],
    key_pem_bytes: Option<&[u8]>,
) -> Result<ParsedClientCertificate, ProxyError> {
    if cert_pem_bytes.is_empty() {
        return Err(ProxyError::Custom("Файл PEM-сертификата пуст.".into()));
    }

    let cert_blocks = pem::parse_many(cert_pem_bytes).map_err(|e| {
        ProxyError::Custom(format!("Некорректный формат PEM в файле сертификата: {e}"))
    })?;

    let mut cert_ders: Vec<Vec<u8>> = Vec::new();
    let mut inline_key: Option<pem::Pem> = None;

    for block in cert_blocks {
        if block.tag() == "CERTIFICATE" {
            cert_ders.push(block.contents().to_vec());
        } else if block.tag() == "ENCRYPTED PRIVATE KEY" {
            return Err(ProxyError::Custom(
                "Зашифрованный PEM-ключ (ENCRYPTED PRIVATE KEY) не поддерживается напрямую. Расшифруйте ключ или используйте .p12 / .pfx."
                    .into(),
            ));
        } else if is_supported_unencrypted_key_tag(block.tag()) && key_pem_bytes.is_none() {
            inline_key = Some(block);
        }
    }

    if cert_ders.is_empty() {
        return Err(ProxyError::Custom(
            "В PEM-файле не найден блок -----BEGIN CERTIFICATE-----.".into(),
        ));
    }

    let key_block = if let Some(raw_key) = key_pem_bytes {
        if raw_key.is_empty() {
            return Err(ProxyError::Custom(
                "Указанный файл закрытого ключа (.key/.pem) пуст.".into(),
            ));
        }
        let key_blocks = pem::parse_many(raw_key).map_err(|e| {
            ProxyError::Custom(format!("Некорректный формат PEM в файле ключа: {e}"))
        })?;
        let mut found_key: Option<pem::Pem> = None;
        for block in key_blocks {
            if block.tag() == "ENCRYPTED PRIVATE KEY" {
                return Err(ProxyError::Custom(
                    "Зашифрованный закрытый ключ (ENCRYPTED PRIVATE KEY) не поддерживается напрямую. Снимите пароль с ключа или импортируйте .p12 / .pfx."
                        .into(),
                ));
            }
            if is_supported_unencrypted_key_tag(block.tag()) {
                found_key = Some(block);
                break;
            }
        }
        found_key.ok_or_else(|| {
            ProxyError::Custom(
                "В файле ключа не найден блок PRIVATE KEY, RSA PRIVATE KEY или EC PRIVATE KEY."
                    .into(),
            )
        })?
    } else {
        inline_key.ok_or_else(|| {
            ProxyError::Custom(
                "В PEM-файле отсутствует закрытый ключ. Объедините сертификат и ключ в один .pem или укажите отдельный файл ключа."
                    .into(),
            )
        })?
    };

    let (common_name, expires_at) = extract_x509_metadata(&cert_ders[0])?;

    let mut normalized_pem = String::new();
    for der in &cert_ders {
        normalized_pem.push_str(&pem::encode(&pem::Pem::new("CERTIFICATE", der.clone())));
    }
    normalized_pem.push_str(&pem::encode(&key_block));

    let identity_pem_bytes = normalized_pem.into_bytes();
    validate_identity_pem_with_reqwest(&identity_pem_bytes)?;

    Ok(ParsedClientCertificate {
        common_name,
        expires_at,
        identity_pem_bytes,
    })
}

fn validate_cert_source_path(
    raw_path: &str,
    allowed_exts: &[&str],
    field_label: &str,
) -> Result<(PathBuf, String), ProxyError> {
    if raw_path.contains('\0') {
        return Err(ProxyError::Custom(format!(
            "Путь к файлу ({field_label}) содержит недопустимый символ."
        )));
    }
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(ProxyError::Custom(format!(
            "Не указан путь к файлу ({field_label})."
        )));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_file() {
        return Err(ProxyError::Custom(format!(
            "Файл не найден или недоступен ({field_label}): {}",
            path.display()
        )));
    }
    let metadata = fs::metadata(&path)?;
    if metadata.len() > MAX_CERT_FILE_BYTES {
        return Err(ProxyError::Custom(format!(
            "Файл {field_label} превышает лимит в 10 МБ."
        )));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !allowed_exts.iter().any(|allowed| *allowed == ext) {
        return Err(ProxyError::Custom(format!(
            "Неподдерживаемое расширение '.{ext}' для {field_label}. Допустимы: {}",
            allowed_exts.join(", ")
        )));
    }
    Ok((path, ext))
}

/// Manages mTLS client certificates (`.p12`/`.pfx` and `.pem`), domain bindings,
/// `0600` vault storage, and cached `reqwest::Client` instances.
pub struct ClientCertificateStore {
    storage_dir: Option<PathBuf>,
    entries: RwLock<Vec<ClientCertificateEntry>>,
    client_cache: Cache<String, reqwest::Client>,
    id_seq: AtomicU64,
}

impl ClientCertificateStore {
    pub fn init_or_load(app_data_dir: &Path) -> Result<Self, ProxyError> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = app_data_dir.join(CLIENT_CERTS_DIR_NAME);
        ensure_secure_dir(&dir)?;

        let registry_path = dir.join(REGISTRY_FILE_NAME);
        let entries = if registry_path.is_file() {
            enforce_secure_file_permissions(&registry_path)?;
            let raw = fs::read_to_string(&registry_path)?;
            let parsed: Vec<ClientCertificateEntry> =
                serde_json::from_str(&raw).map_err(|e| {
                    ProxyError::Custom(format!(
                        "Не удалось прочитать реестр клиентских сертификатов: {e}"
                    ))
                })?;
            for entry in &parsed {
                let stored = Path::new(&entry.stored_cert_path);
                let _ = enforce_secure_file_permissions(stored);
                if entry.format == ClientCertificateFormat::Pkcs12 {
                    let identity_path = dir.join(format!("{}.identity.pem", entry.id));
                    let _ = enforce_secure_file_permissions(&identity_path);
                }
            }
            parsed
        } else {
            Vec::new()
        };

        Ok(Self {
            storage_dir: Some(dir),
            entries: RwLock::new(entries),
            client_cache: Cache::builder().max_capacity(CLIENT_CACHE_CAPACITY).build(),
            id_seq: AtomicU64::new(1),
        })
    }

    pub fn in_memory() -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Self {
            storage_dir: None,
            entries: RwLock::new(Vec::new()),
            client_cache: Cache::builder().max_capacity(CLIENT_CACHE_CAPACITY).build(),
            id_seq: AtomicU64::new(1),
        }
    }

    #[cfg(test)]
    pub(crate) fn cache_entry_count(&self) -> u64 {
        self.client_cache.run_pending_tasks();
        self.client_cache.entry_count()
    }

    fn persist_registry(&self, entries: &[ClientCertificateEntry]) -> Result<(), ProxyError> {
        let Some(ref dir) = self.storage_dir else {
            return Ok(());
        };
        ensure_secure_dir(dir)?;
        let json = serde_json::to_vec_pretty(entries).map_err(|e| {
            ProxyError::Custom(format!(
                "Не удалось сериализовать реестр клиентских сертификатов: {e}"
            ))
        })?;
        write_bytes_securely(&dir.join(REGISTRY_FILE_NAME), &json)?;
        Ok(())
    }

    fn identity_pem_path_for_entry(&self, entry: &ClientCertificateEntry) -> PathBuf {
        match entry.format {
            ClientCertificateFormat::Pem => PathBuf::from(&entry.stored_cert_path),
            ClientCertificateFormat::Pkcs12 => {
                if let Some(ref dir) = self.storage_dir {
                    dir.join(format!("{}.identity.pem", entry.id))
                } else {
                    let stored = Path::new(&entry.stored_cert_path);
                    stored
                        .parent()
                        .unwrap_or_else(|| Path::new("."))
                        .join(format!("{}.identity.pem", entry.id))
                }
            }
        }
    }

    pub fn list(&self) -> Vec<ClientCertificateEntry> {
        self.entries
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    pub fn add_certificate(
        &self,
        req: AddClientCertificateRequest,
    ) -> Result<ClientCertificateEntry, ProxyError> {
        let domain_pattern = normalize_domain_pattern(&req.domain_pattern)?;
        let (cert_path, cert_ext) = validate_cert_source_path(
            &req.cert_path,
            &["p12", "pfx", "pem", "crt", "cer"],
            "сертификата",
        )?;

        let format = if cert_ext == "p12" || cert_ext == "pfx" {
            ClientCertificateFormat::Pkcs12
        } else {
            ClientCertificateFormat::Pem
        };

        let cert_bytes = fs::read(&cert_path)?;
        let parsed = match format {
            ClientCertificateFormat::Pkcs12 => {
                let password = req.password.as_deref().unwrap_or("");
                parse_pkcs12_identity(&cert_bytes, password)?
            }
            ClientCertificateFormat::Pem => {
                let key_bytes = if let Some(raw_key_path) = req
                    .key_path
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let (kp, _) =
                        validate_cert_source_path(raw_key_path, &["key", "pem"], "закрытого ключа")?;
                    Some(fs::read(&kp)?)
                } else {
                    None
                };
                parse_pem_identity(&cert_bytes, key_bytes.as_deref())?
            }
        };

        let seq = self.id_seq.fetch_add(1, Ordering::Relaxed);
        let id = format!("mcert-{}-{seq}", Utc::now().timestamp_millis());

        let stored_cert_path = if let Some(ref dir) = self.storage_dir {
            ensure_secure_dir(dir)?;
            match format {
                ClientCertificateFormat::Pkcs12 => {
                    let archive_path = dir.join(format!("{id}.{cert_ext}"));
                    write_bytes_securely(&archive_path, &cert_bytes)?;
                    let identity_path = dir.join(format!("{id}.identity.pem"));
                    write_bytes_securely(&identity_path, &parsed.identity_pem_bytes)?;
                    archive_path.display().to_string()
                }
                ClientCertificateFormat::Pem => {
                    let pem_path = dir.join(format!("{id}.pem"));
                    write_bytes_securely(&pem_path, &parsed.identity_pem_bytes)?;
                    pem_path.display().to_string()
                }
            }
        } else {
            // In-memory fallback writes no files; keep source path only as identifier.
            cert_path.display().to_string()
        };

        let label = req
            .label
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| parsed.common_name.clone());

        let entry = ClientCertificateEntry {
            id,
            domain_pattern,
            label,
            format,
            stored_cert_path,
            common_name: parsed.common_name,
            expires_at: parsed.expires_at,
            enabled: req.enabled.unwrap_or(true),
        };

        {
            let mut guard = self.entries.write().map_err(|_| {
                ProxyError::Custom("Ошибка блокировки реестра клиентских сертификатов.".into())
            })?;
            let mut next = guard.clone();
            next.push(entry.clone());
            self.persist_registry(&next)?;
            *guard = next;
        }

        self.client_cache.invalidate_all();
        Ok(entry)
    }

    pub fn toggle_certificate(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<ClientCertificateEntry, ProxyError> {
        let updated = {
            let mut guard = self.entries.write().map_err(|_| {
                ProxyError::Custom("Ошибка блокировки реестра клиентских сертификатов.".into())
            })?;
            let mut next = guard.clone();
            let Some(item) = next.iter_mut().find(|e| e.id == id) else {
                return Err(ProxyError::Custom(format!(
                    "Клиентский сертификат с ID '{id}' не найден."
                )));
            };
            item.enabled = enabled;
            let cloned = item.clone();
            self.persist_registry(&next)?;
            *guard = next;
            cloned
        };

        self.client_cache.invalidate_all();
        Ok(updated)
    }

    pub fn remove_certificate(&self, id: &str) -> Result<Vec<ClientCertificateEntry>, ProxyError> {
        let (removed, remaining) = {
            let mut guard = self.entries.write().map_err(|_| {
                ProxyError::Custom("Ошибка блокировки реестра клиентских сертификатов.".into())
            })?;
            let Some(pos) = guard.iter().position(|e| e.id == id) else {
                return Err(ProxyError::Custom(format!(
                    "Клиентский сертификат с ID '{id}' не найден."
                )));
            };
            let mut next = guard.clone();
            let removed = next.remove(pos);
            self.persist_registry(&next)?;
            *guard = next.clone();
            (removed, next)
        };

        if self.storage_dir.is_some() {
            let stored_path = Path::new(&removed.stored_cert_path);
            match fs::remove_file(stored_path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    tracing::warn!(
                        "Failed to remove stored client certificate {}: {err}",
                        stored_path.display()
                    );
                }
            }
            if removed.format == ClientCertificateFormat::Pkcs12 {
                let identity_path = self.identity_pem_path_for_entry(&removed);
                match fs::remove_file(&identity_path) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => {
                        tracing::warn!(
                            "Failed to remove cached mTLS PEM identity {}: {err}",
                            identity_path.display()
                        );
                    }
                }
            }
        }

        self.client_cache.invalidate_all();
        Ok(remaining)
    }

    /// Finds the highest-specificity enabled client certificate matching `host`.
    pub fn match_certificate_for_host(&self, host: &str) -> Option<ClientCertificateEntry> {
        let norm_host = normalize_host_for_match(host);
        if norm_host.is_empty() {
            return None;
        }

        let guard = self.entries.read().ok()?;
        let mut best: Option<((u8, usize), &ClientCertificateEntry)> = None;
        for entry in guard.iter() {
            if !entry.enabled {
                continue;
            }
            if domain_pattern_matches_host(&entry.domain_pattern, &norm_host) {
                let rank = match_specificity_rank(&entry.domain_pattern);
                if best.map(|(best_rank, _)| rank > best_rank).unwrap_or(true) {
                    best = Some((rank, entry));
                }
            }
        }
        best.map(|(_, e)| e.clone())
    }

    /// Returns a cached or freshly constructed `reqwest::Client` configured with the matching
    /// mTLS client certificate for `host`, or `Ok(None)` if no enabled certificate matches.
    pub fn get_or_build_client(
        &self,
        host: &str,
        follow_redirects: bool,
    ) -> Result<Option<(reqwest::Client, ClientCertificateEntry)>, ProxyError> {
        let Some(entry) = self.match_certificate_for_host(host) else {
            return Ok(None);
        };

        let cache_key = format!("{}:redirect={follow_redirects}", entry.id);
        if let Some(cached) = self.client_cache.get(&cache_key) {
            return Ok(Some((cached, entry)));
        }

        let identity_path = self.identity_pem_path_for_entry(&entry);
        let pem_bytes = fs::read(&identity_path).map_err(|e| {
            ProxyError::Custom(format!(
                "Не удалось прочитать файл mTLS-идентичности '{}': {e}",
                identity_path.display()
            ))
        })?;
        let identity = reqwest::Identity::from_pem(&pem_bytes).map_err(|e| {
            ProxyError::Custom(format!(
                "Ошибка загрузки mTLS-идентичности для '{}': {e}",
                entry.domain_pattern
            ))
        })?;
        let client = build_upstream_client_with_identity(follow_redirects, Some(identity))
            .map_err(|e| {
                ProxyError::Custom(format!(
                    "Ошибка сборки mTLS-клиента для '{}': {e}",
                    entry.domain_pattern
                ))
            })?;

        self.client_cache.insert(cache_key, client.clone());
        Ok(Some((client, entry)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p12_keystore::{Certificate as P12Cert, KeyStore, KeyStoreEntry, PrivateKeyChain};
    use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair};
    use time::{Duration as TimeDuration, OffsetDateTime};

    fn unique_test_dir(prefix: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_{prefix}_{}_{seq}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mint_self_signed_client_cert(cn: &str, days_valid: i64) -> (Vec<u8>, String, Vec<u8>, String) {
        let mut params = CertificateParams::new(vec![cn.to_string()]).unwrap();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, cn);
        params.distinguished_name = dn;
        let now = OffsetDateTime::now_utc();
        params.not_before = now - TimeDuration::hours(1);
        params.not_after = now + TimeDuration::days(days_valid);

        let key = KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        (
            cert.der().to_vec(),
            cert.pem(),
            key.serialize_der(),
            key.serialize_pem(),
        )
    }

    fn build_pkcs12_bytes(cert_der: &[u8], key_der: &[u8], password: &str) -> Vec<u8> {
        let p12_cert = P12Cert::from_der(cert_der).unwrap();
        let chain = PrivateKeyChain::new(key_der, b"local-key-1", vec![p12_cert]);
        let mut ks = KeyStore::new();
        ks.add_entry("client-alias", KeyStoreEntry::PrivateKeyChain(chain));
        ks.writer(password).write().unwrap()
    }

    #[test]
    fn parses_combined_and_split_pem_and_extracts_x509_metadata() {
        let (cert_der, cert_pem, _key_der, key_pem) =
            mint_self_signed_client_cert("svc-billing.internal.corp", 90);
        let (cn, expires_at) = extract_x509_metadata(&cert_der).unwrap();
        assert_eq!(cn, "svc-billing.internal.corp");
        assert!(expires_at.ends_with('Z'));
        let parsed_dt = chrono::DateTime::parse_from_rfc3339(&expires_at).unwrap();
        assert!(parsed_dt > Utc::now() + chrono::Duration::days(80));

        // Combined PEM (with extra EC PARAMETERS block that must be ignored cleanly)
        let combined = format!(
            "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n{cert_pem}{key_pem}"
        );
        let parsed_combined = parse_pem_identity(combined.as_bytes(), None).unwrap();
        assert_eq!(parsed_combined.common_name, "svc-billing.internal.corp");
        assert_eq!(parsed_combined.expires_at, expires_at);

        // Split cert.pem + key.key
        let parsed_split =
            parse_pem_identity(cert_pem.as_bytes(), Some(key_pem.as_bytes())).unwrap();
        assert_eq!(parsed_split.common_name, "svc-billing.internal.corp");

        // Encrypted PEM key must be rejected with clear error
        let encrypted_pem = format!(
            "{cert_pem}-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"
        );
        let enc_err = parse_pem_identity(encrypted_pem.as_bytes(), None).unwrap_err();
        assert!(enc_err.to_string().contains("ENCRYPTED PRIVATE KEY"));

        // Mismatched key + cert must be rejected by rustls validation
        let (_other_der, _other_cert_pem, _other_key_der, other_key_pem) =
            mint_self_signed_client_cert("other.internal.corp", 30);
        assert!(parse_pem_identity(cert_pem.as_bytes(), Some(other_key_pem.as_bytes())).is_err());
    }

    #[test]
    fn parses_pkcs12_archive_and_rejects_wrong_password() {
        let (cert_der, _cert_pem, key_der, _key_pem) =
            mint_self_signed_client_cert("mtls-gateway.prod.local", 180);
        let p12_bytes = build_pkcs12_bytes(&cert_der, &key_der, "s3cr3t-p12!");

        let parsed = parse_pkcs12_identity(&p12_bytes, "s3cr3t-p12!").unwrap();
        assert_eq!(parsed.common_name, "mtls-gateway.prod.local");
        assert!(parsed.expires_at.ends_with('Z'));
        let pem_str = std::str::from_utf8(&parsed.identity_pem_bytes).unwrap();
        assert!(pem_str.contains("BEGIN CERTIFICATE"));
        assert!(pem_str.contains("BEGIN PRIVATE KEY"));

        assert!(parse_pkcs12_identity(&p12_bytes, "wrong-password").is_err());
        assert!(parse_pkcs12_identity(b"not-a-valid-p12", "s3cr3t-p12!").is_err());
    }

    #[test]
    fn validates_and_matches_exact_and_wildcard_domains_with_specificity() {
        assert_eq!(
            normalize_domain_pattern("HTTPS://API.Corp.Local:8443/v1").unwrap(),
            "api.corp.local"
        );
        assert_eq!(
            normalize_domain_pattern(" *.Internal.CORP. ").unwrap(),
            "*.internal.corp"
        );
        assert!(normalize_domain_pattern("").is_err());
        assert!(normalize_domain_pattern("*").is_err());
        assert!(normalize_domain_pattern("*.").is_err());
        assert!(normalize_domain_pattern("api.*.corp.local").is_err());

        assert!(domain_pattern_matches_host("api.corp.local", "API.CORP.LOCAL:8443"));
        assert!(!domain_pattern_matches_host("api.corp.local", "v2.api.corp.local"));

        assert!(domain_pattern_matches_host("*.corp.local", "api.corp.local"));
        assert!(domain_pattern_matches_host("*.corp.local", "a.b.corp.local:443"));
        assert!(!domain_pattern_matches_host("*.corp.local", "corp.local"));
        assert!(!domain_pattern_matches_host("*.corp.local", "evilcorp.local"));

        let tmp = unique_test_dir("match_specificity");
        let store = ClientCertificateStore::init_or_load(&tmp).unwrap();

        let (der_broad, _, key_broad, _) = mint_self_signed_client_cert("broad", 60);
        let p12_broad = tmp.join("broad.p12");
        fs::write(&p12_broad, build_pkcs12_bytes(&der_broad, &key_broad, "pw1")).unwrap();

        let (der_sub, _, key_sub, _) = mint_self_signed_client_cert("eu-sub", 60);
        let p12_sub = tmp.join("sub.p12");
        fs::write(&p12_sub, build_pkcs12_bytes(&der_sub, &key_sub, "pw2")).unwrap();

        let (der_exact, _, key_exact, _) = mint_self_signed_client_cert("exact", 60);
        let p12_exact = tmp.join("exact.p12");
        fs::write(&p12_exact, build_pkcs12_bytes(&der_exact, &key_exact, "pw3")).unwrap();

        let e_broad = store
            .add_certificate(AddClientCertificateRequest {
                domain_pattern: "*.corp.local".into(),
                label: Some("Broad".into()),
                cert_path: p12_broad.display().to_string(),
                key_path: None,
                password: Some("pw1".into()),
                enabled: Some(true),
            })
            .unwrap();
        let e_sub = store
            .add_certificate(AddClientCertificateRequest {
                domain_pattern: "*.eu.corp.local".into(),
                label: Some("EU".into()),
                cert_path: p12_sub.display().to_string(),
                key_path: None,
                password: Some("pw2".into()),
                enabled: Some(true),
            })
            .unwrap();
        let e_exact = store
            .add_certificate(AddClientCertificateRequest {
                domain_pattern: "payments.eu.corp.local".into(),
                label: Some("Exact".into()),
                cert_path: p12_exact.display().to_string(),
                key_path: None,
                password: Some("pw3".into()),
                enabled: Some(true),
            })
            .unwrap();

        assert_eq!(
            store
                .match_certificate_for_host("payments.eu.corp.local:8443")
                .unwrap()
                .id,
            e_exact.id
        );
        assert_eq!(
            store
                .match_certificate_for_host("orders.eu.corp.local")
                .unwrap()
                .id,
            e_sub.id
        );
        assert_eq!(
            store
                .match_certificate_for_host("auth.corp.local")
                .unwrap()
                .id,
            e_broad.id
        );
        assert!(store.match_certificate_for_host("corp.local").is_none());

        // Disabling exact falls back to *.eu.corp.local
        store.toggle_certificate(&e_exact.id, false).unwrap();
        assert_eq!(
            store
                .match_certificate_for_host("payments.eu.corp.local")
                .unwrap()
                .id,
            e_sub.id
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn caches_clients_invalidates_on_mutations_and_never_stores_passwords() {
        let tmp = unique_test_dir("cache_and_vault");
        let app_data = tmp.join("app_data");
        let import_dir = tmp.join("imports");
        fs::create_dir_all(&import_dir).unwrap();

        let secret_password = "ultra-secret-p12-passphrase";
        let (cert_der, _cert_pem, key_der, _key_pem) =
            mint_self_signed_client_cert("client.vault.test", 120);
        let source_p12 = import_dir.join("vault.pfx");
        fs::write(&source_p12, build_pkcs12_bytes(&cert_der, &key_der, secret_password)).unwrap();

        let store = ClientCertificateStore::init_or_load(&app_data).unwrap();
        let added = store
            .add_certificate(AddClientCertificateRequest {
                domain_pattern: "*.vault.test".into(),
                label: Some("Vault Gateway".into()),
                cert_path: source_p12.display().to_string(),
                key_path: None,
                password: Some(secret_password.into()),
                enabled: Some(true),
            })
            .unwrap();

        assert_eq!(added.format, ClientCertificateFormat::Pkcs12);
        assert!(Path::new(&added.stored_cert_path).is_file());
        let identity_pem = app_data
            .join(CLIENT_CERTS_DIR_NAME)
            .join(format!("{}.identity.pem", added.id));
        assert!(identity_pem.is_file());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let cert_mode = fs::metadata(&added.stored_cert_path).unwrap().permissions().mode() & 0o777;
            let pem_mode = fs::metadata(&identity_pem).unwrap().permissions().mode() & 0o777;
            assert_eq!(cert_mode, 0o600);
            assert_eq!(pem_mode, 0o600);
        }

        // Verify password is never written to registry.json
        let registry_raw =
            fs::read_to_string(app_data.join(CLIENT_CERTS_DIR_NAME).join(REGISTRY_FILE_NAME))
                .unwrap();
        assert!(!registry_raw.contains(secret_password));
        assert!(!registry_raw.contains("password"));

        // Cache populates separately for follow_redirects=false and follow_redirects=true
        assert_eq!(store.cache_entry_count(), 0);
        assert!(store.get_or_build_client("api.vault.test", false).unwrap().is_some());
        assert_eq!(store.cache_entry_count(), 1);
        assert!(store.get_or_build_client("api.vault.test", false).unwrap().is_some());
        assert_eq!(store.cache_entry_count(), 1);
        assert!(store.get_or_build_client("api.vault.test", true).unwrap().is_some());
        assert_eq!(store.cache_entry_count(), 2);

        // Toggle invalidates cache and disables matching
        store.toggle_certificate(&added.id, false).unwrap();
        assert_eq!(store.cache_entry_count(), 0);
        assert!(store.get_or_build_client("api.vault.test", false).unwrap().is_none());

        store.toggle_certificate(&added.id, true).unwrap();
        assert!(store.get_or_build_client("api.vault.test", false).unwrap().is_some());
        assert_eq!(store.cache_entry_count(), 1);

        // Reloading from disk keeps entries and builds mTLS client without needing the password again
        let reloaded_store = ClientCertificateStore::init_or_load(&app_data).unwrap();
        assert_eq!(reloaded_store.list().len(), 1);
        assert!(reloaded_store
            .get_or_build_client("api.vault.test", false)
            .unwrap()
            .is_some());

        // Removing deletes vault files and invalidates cache
        let remaining = store.remove_certificate(&added.id).unwrap();
        assert!(remaining.is_empty());
        assert_eq!(store.cache_entry_count(), 0);
        assert!(!Path::new(&added.stored_cert_path).exists());
        assert!(!identity_pem.exists());

        let _ = fs::remove_dir_all(&tmp);
    }
}
