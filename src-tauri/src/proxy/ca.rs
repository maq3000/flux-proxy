use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use base64::Engine as _;
use moka::sync::Cache;
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime, UtcOffset};

use crate::models::{CaCertificateInfo, ProxyError};

pub const ROOT_CA_COMMON_NAME: &str = "FluxProxy Local Debugging Root CA";
pub const OS_PRIVILEGE_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_OS_CMD_CAPTURE_BYTES: usize = 1024 * 1024;

const LINUX_DEBIAN_CA_DIR: &str = "/usr/local/share/ca-certificates";
const LINUX_DEBIAN_CA_CERT_PATH: &str = "/usr/local/share/ca-certificates/fluxproxy-root-ca.crt";
const LINUX_REDHAT_CA_DIR: &str = "/etc/pki/ca-trust/source/anchors";
const LINUX_REDHAT_CA_CERT_PATH: &str = "/etc/pki/ca-trust/source/anchors/fluxproxy-root-ca.crt";
const LINUX_ARCH_CA_DIR: &str = "/etc/ca-certificates/trust-source/anchors";
const LINUX_ARCH_CA_CERT_PATH: &str = "/etc/ca-certificates/trust-source/anchors/fluxproxy-root-ca.crt";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const LINUX_ALL_CA_CERT_PATHS: [&str; 3] = [
    LINUX_DEBIAN_CA_CERT_PATH,
    LINUX_REDHAT_CA_CERT_PATH,
    LINUX_ARCH_CA_CERT_PATH,
];

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinuxCaStoreKind {
    DebianUpdateCaCertificates,
    RedHatUpdateCaTrust,
    ArchTrustAnchor,
}

impl LinuxCaStoreKind {
    pub fn cert_path(self) -> &'static str {
        match self {
            Self::DebianUpdateCaCertificates => LINUX_DEBIAN_CA_CERT_PATH,
            Self::RedHatUpdateCaTrust => LINUX_REDHAT_CA_CERT_PATH,
            Self::ArchTrustAnchor => LINUX_ARCH_CA_CERT_PATH,
        }
    }

    #[allow(dead_code)]
    pub fn anchor_dir(self) -> &'static str {
        match self {
            Self::DebianUpdateCaCertificates => LINUX_DEBIAN_CA_DIR,
            Self::RedHatUpdateCaTrust => LINUX_REDHAT_CA_DIR,
            Self::ArchTrustAnchor => LINUX_ARCH_CA_DIR,
        }
    }

    pub fn backend_id(self) -> &'static str {
        match self {
            Self::DebianUpdateCaCertificates => "update-ca-certificates",
            Self::RedHatUpdateCaTrust => "update-ca-trust",
            Self::ArchTrustAnchor => "trust-anchor",
        }
    }
}

#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
pub(crate) fn detect_linux_ca_store_with<FDir, FBin>(
    mut dir_exists: FDir,
    mut bin_exists: FBin,
) -> Option<LinuxCaStoreKind>
where
    FDir: FnMut(&str) -> bool,
    FBin: FnMut(&str) -> bool,
{
    if bin_exists("update-ca-certificates") && dir_exists(LINUX_DEBIAN_CA_DIR) {
        return Some(LinuxCaStoreKind::DebianUpdateCaCertificates);
    }
    if bin_exists("update-ca-trust") && dir_exists(LINUX_REDHAT_CA_DIR) {
        return Some(LinuxCaStoreKind::RedHatUpdateCaTrust);
    }
    if bin_exists("trust") && dir_exists(LINUX_ARCH_CA_DIR) {
        return Some(LinuxCaStoreKind::ArchTrustAnchor);
    }

    if bin_exists("update-ca-certificates") {
        return Some(LinuxCaStoreKind::DebianUpdateCaCertificates);
    }
    if bin_exists("update-ca-trust") {
        return Some(LinuxCaStoreKind::RedHatUpdateCaTrust);
    }
    if bin_exists("trust") {
        return Some(LinuxCaStoreKind::ArchTrustAnchor);
    }

    if dir_exists(LINUX_DEBIAN_CA_DIR) {
        return Some(LinuxCaStoreKind::DebianUpdateCaCertificates);
    }
    if dir_exists(LINUX_REDHAT_CA_DIR) {
        return Some(LinuxCaStoreKind::RedHatUpdateCaTrust);
    }
    if dir_exists(LINUX_ARCH_CA_DIR) {
        return Some(LinuxCaStoreKind::ArchTrustAnchor);
    }

    None
}

#[cfg(target_os = "linux")]
fn linux_binary_exists(name: &str) -> bool {
    if let Some(path_os) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_os) {
            if dir.join(name).is_file() {
                return true;
            }
        }
    }
    for fallback_dir in ["/usr/sbin", "/sbin", "/usr/bin", "/bin"] {
        if Path::new(fallback_dir).join(name).is_file() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "linux")]
pub(crate) fn detect_linux_ca_store() -> Option<LinuxCaStoreKind> {
    detect_linux_ca_store_with(|dir| Path::new(dir).is_dir(), linux_binary_exists)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn is_installed_in_linux_anchor_paths(paths: &[&Path], active_ca_der: &[u8]) -> bool {
    paths.iter().any(|p| {
        fs::read(p)
            .map(|bytes| cert_file_matches_ca_der(&bytes, active_ca_der))
            .unwrap_or(false)
    })
}

fn sha256_digest(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn format_valid_until(dt: OffsetDateTime) -> String {
    let utc = dt.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        utc.year(),
        utc.month() as u8,
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second(),
    )
}

fn extract_der_from_pem(pem_str: &str) -> Result<Vec<u8>, ProxyError> {
    const BEGIN_MARKER: &str = "-----BEGIN CERTIFICATE-----";
    const END_MARKER: &str = "-----END CERTIFICATE-----";

    let begin_idx = pem_str
        .find(BEGIN_MARKER)
        .ok_or_else(|| ProxyError::Custom("Missing BEGIN CERTIFICATE marker in Root CA PEM".into()))?;
    let after_begin = &pem_str[begin_idx + BEGIN_MARKER.len()..];
    let end_idx = after_begin
        .find(END_MARKER)
        .ok_or_else(|| ProxyError::Custom("Missing END CERTIFICATE marker in Root CA PEM".into()))?;

    let b64_compact: String = after_begin[..end_idx]
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if b64_compact.is_empty() {
        return Err(ProxyError::Custom("Empty Root CA certificate PEM block".into()));
    }
    base64::engine::general_purpose::STANDARD
        .decode(b64_compact)
        .map_err(|e| ProxyError::Custom(format!("Invalid base64 in Root CA PEM: {e}")))
}

fn encode_der_to_pem(der: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        if let Ok(line) = std::str::from_utf8(chunk) {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn cert_file_matches_ca_der(installed_bytes: &[u8], active_ca_der: &[u8]) -> bool {
    if installed_bytes.is_empty() || active_ca_der.is_empty() {
        return false;
    }
    let active_digest = sha256_digest(active_ca_der);
    if sha256_digest(installed_bytes) == active_digest {
        return true;
    }
    if let Ok(text) = std::str::from_utf8(installed_bytes) {
        if let Ok(installed_der) = extract_der_from_pem(text) {
            return sha256_digest(&installed_der) == active_digest;
        }
    }
    false
}

/// Verifies that the CLI trust-store output contains a 64-hex SHA-256 fingerprint matching
/// the active Root CA certificate (case-insensitive, ignoring colon/space separators and localized labels).
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub(crate) fn output_contains_sha256_fingerprint(output: &str, expected_sha256_hex: &str) -> bool {
    let expected: String = expected_sha256_hex
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    if expected.len() != 64 {
        return false;
    }

    output.lines().any(|line| {
        let candidate_part = line
            .split_once(':')
            .map(|(_, rhs)| rhs)
            .unwrap_or(line)
            .trim();
        if candidate_part.is_empty()
            || !candidate_part
                .chars()
                .all(|c| c.is_ascii_hexdigit() || matches!(c, ' ' | '\t' | ':' | '-'))
        {
            return false;
        }
        let hex: String = candidate_part
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        hex.len() == 64 && hex == expected
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OsCommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub success_message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommandExecutionOutcome {
    Completed {
        success: bool,
        stdout: String,
        stderr: String,
    },
    TimedOut {
        timeout_secs: u64,
        stdout: String,
        stderr: String,
    },
}

fn new_os_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn_pipe_reader<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let text = if let Some(mut reader) = pipe {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        let remaining = MAX_OS_CMD_CAPTURE_BYTES.saturating_sub(buf.len());
                        if remaining > 0 {
                            buf.extend_from_slice(&chunk[..n.min(remaining)]);
                        }
                    }
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&buf).into_owned()
        } else {
            String::new()
        };
        let _ = tx.send(text);
    });
    rx
}

pub(crate) fn run_command_with_timeout(
    program: &str,
    args: &[String],
    timeout: std::time::Duration,
) -> Result<CommandExecutionOutcome, std::io::Error> {
    use std::process::Stdio;

    let mut child = new_os_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout_rx = spawn_pipe_reader(child.stdout.take());
    let stderr_rx = spawn_pipe_reader(child.stderr.take());
    let deadline = std::time::Instant::now() + timeout;

    loop {
        if let Some(status) = child.try_wait()? {
            let stdout = stdout_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or_default();
            let stderr = stderr_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or_default();
            return Ok(CommandExecutionOutcome::Completed {
                success: status.success(),
                stdout,
                stderr,
            });
        }

        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = stdout_rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .unwrap_or_default();
            let stderr = stderr_rx
                .recv_timeout(std::time::Duration::from_millis(200))
                .unwrap_or_default();
            return Ok(CommandExecutionOutcome::TimedOut {
                timeout_secs: timeout.as_secs().max(1),
                stdout,
                stderr,
            });
        }

        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

fn shell_quote_posix(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\"'\"'"))
}

fn shell_quote_windows(raw: &str) -> String {
    let escaped = raw.replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn format_command_error(stderr: &str, stdout: &str, fallback: &str) -> String {
    let err_trimmed = stderr.trim();
    if !err_trimmed.is_empty() {
        return err_trimmed.to_string();
    }
    let out_trimmed = stdout.trim();
    if !out_trimmed.is_empty() {
        return out_trimmed.to_string();
    }
    fallback.to_string()
}

fn write_private_key_securely(path: &Path, pem_contents: &str) -> Result<(), std::io::Error> {
    crate::proxy::dpapi::write_protected_key_bytes(path, pem_contents.as_bytes())
}

fn enforce_private_key_permissions(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Manages the local Root Certificate Authority and caches dynamically minted
/// per-host ECDSA P-256 TLS `ServerConfig` instances for low-latency MITM handshakes.
pub struct CertificateAuthority {
    ca_cert: Certificate,
    ca_key: KeyPair,
    ca_pem: String,
    ca_der: Vec<u8>,
    cert_pem_path: PathBuf,
    cert_cer_path: PathBuf,
    key_pem_path: PathBuf,
    sha256_fingerprint: String,
    valid_until: String,
    leaf_cache: Cache<String, Arc<ServerConfig>>,
    #[cfg(test)]
    leaf_gen_count: std::sync::atomic::AtomicUsize,
}

impl CertificateAuthority {
    pub fn init_or_load(storage_dir: &Path) -> Result<Self, ProxyError> {
        // Ensure ring crypto provider is installed once for rustls 0.23+
        let _ = rustls::crypto::ring::default_provider().install_default();

        let ca_dir = storage_dir.join("ca");
        fs::create_dir_all(&ca_dir)?;

        let cert_pem_path = ca_dir.join("fluxproxy-root-ca.pem");
        let cert_cer_path = ca_dir.join("fluxproxy-root-ca.cer");
        let key_pem_path = ca_dir.join("fluxproxy-root-ca.key");
        let legacy_key_pem_path = ca_dir.join("fluxproxy-root-ca-key.pem");

        let has_key = key_pem_path.exists() || legacy_key_pem_path.exists();

        let (ca_cert, ca_key, ca_pem, der_bytes, valid_until) =
            if has_key && (cert_pem_path.exists() || cert_cer_path.exists()) {
                let key_pem = if key_pem_path.exists() {
                    enforce_private_key_permissions(&key_pem_path)?;
                    if legacy_key_pem_path.exists() {
                        let _ = fs::remove_file(&legacy_key_pem_path);
                    }
                    crate::proxy::dpapi::read_protected_key_string(&key_pem_path)?
                } else {
                    let migrated =
                        crate::proxy::dpapi::read_protected_key_string(&legacy_key_pem_path)?;
                    write_private_key_securely(&key_pem_path, &migrated)?;
                    let _ = fs::remove_file(&legacy_key_pem_path);
                    migrated
                };
                let ca_key = KeyPair::from_pem(&key_pem)?;

                let (cert_pem, loaded_der, mut params) = if cert_pem_path.exists() {
                    let pem_text = fs::read_to_string(&cert_pem_path)?;
                    let parsed_der = extract_der_from_pem(&pem_text)?;
                    let parsed_params = CertificateParams::from_ca_cert_pem(&pem_text)?;
                    match fs::read(&cert_cer_path) {
                        Ok(existing_cer) if existing_cer == parsed_der => {}
                        _ => {
                            // Recreate missing or corrupted `.cer` strictly from the loaded CA PEM
                            fs::write(&cert_cer_path, &parsed_der)?;
                        }
                    }
                    (pem_text, parsed_der, parsed_params)
                } else {
                    let existing_der = fs::read(&cert_cer_path)?;
                    let cert_der_ref = CertificateDer::from(existing_der.as_slice());
                    let parsed_params = CertificateParams::from_ca_cert_der(&cert_der_ref)?;
                    let pem_text = encode_der_to_pem(&existing_der);
                    fs::write(&cert_pem_path, &pem_text)?;
                    (pem_text, existing_der, parsed_params)
                };

                let valid_until = format_valid_until(params.not_after);
                params.use_authority_key_identifier_extension = true;
                // Construct signer handle only for leaf signing; `cert_pem` & `loaded_der` remain the source of truth
                let ca_cert = params.self_signed(&ca_key)?;
                (ca_cert, ca_key, cert_pem, loaded_der, valid_until)
            } else {
                let mut params = CertificateParams::default();
                params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
                params.use_authority_key_identifier_extension = true;

                let mut dn = DistinguishedName::new();
                dn.push(DnType::CommonName, ROOT_CA_COMMON_NAME);
                dn.push(DnType::OrganizationName, "FluxProxy Web Debugger");
                dn.push(DnType::CountryName, "US");
                params.distinguished_name = dn;

                params.key_usages = vec![
                    KeyUsagePurpose::KeyCertSign,
                    KeyUsagePurpose::CrlSign,
                    KeyUsagePurpose::DigitalSignature,
                ];

                let now = OffsetDateTime::now_utc();
                params.not_before = now - Duration::days(1);
                params.not_after = now + Duration::days(3650);
                let valid_until = format_valid_until(params.not_after);

                let ca_key = KeyPair::generate()?;
                let ca_cert = params.self_signed(&ca_key)?;
                let pem_text = ca_cert.pem();
                let der_bytes = ca_cert.der().to_vec();

                fs::write(&cert_pem_path, &pem_text)?;
                fs::write(&cert_cer_path, &der_bytes)?;
                write_private_key_securely(&key_pem_path, &ca_key.serialize_pem())?;

                (ca_cert, ca_key, pem_text, der_bytes, valid_until)
            };

        let digest = hex::encode_upper(sha256_digest(&der_bytes));
        let sha256_fingerprint = digest
            .as_bytes()
            .chunks(2)
            .map(|c| std::str::from_utf8(c).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(":");

        let leaf_cache = Cache::builder().max_capacity(2_048).build();

        Ok(Self {
            ca_cert,
            ca_key,
            ca_pem,
            ca_der: der_bytes,
            cert_pem_path,
            cert_cer_path,
            key_pem_path,
            sha256_fingerprint,
            valid_until,
            leaf_cache,
            #[cfg(test)]
            leaf_gen_count: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    pub fn info(&self) -> CaCertificateInfo {
        let target_os = std::env::consts::OS;
        #[cfg(target_os = "linux")]
        let linux_store = detect_linux_ca_store();
        #[cfg(not(target_os = "linux"))]
        let linux_store: Option<LinuxCaStoreKind> = None;

        let trust_store_backend = match target_os {
            "windows" => Some("certutil".to_string()),
            "macos" => Some("security".to_string()),
            "linux" => linux_store.map(|s| s.backend_id().to_string()),
            _ => None,
        };
        let manual_install_command =
            Some(self.manual_install_command_for_os_and_store(target_os, linux_store));

        CaCertificateInfo {
            cert_pem_path: self.cert_pem_path.display().to_string(),
            cert_cer_path: self.cert_cer_path.display().to_string(),
            sha256_fingerprint: self.sha256_fingerprint.clone(),
            subject: format!("CN={ROOT_CA_COMMON_NAME}, O=FluxProxy Web Debugger"),
            valid_until: self.valid_until.clone(),
            is_trusted: false,
            manual_install_command,
            trust_store_backend,
        }
    }

    pub fn info_with_trust_status(&self) -> CaCertificateInfo {
        let mut info = self.info();
        info.is_trusted = self.is_installed_in_os_trust_store();
        info
    }

    pub fn key_pem_path(&self) -> &Path {
        &self.key_pem_path
    }

    /// Non-destructively checks whether the FluxProxy Root CA is currently present in the OS trust store
    /// AND matches the active Root CA SHA-256 fingerprint.
    pub fn is_installed_in_os_trust_store(&self) -> bool {
        #[cfg(target_os = "windows")]
        {
            new_os_command("certutil")
                .args(["-user", "-store", "-v", "Root", ROOT_CA_COMMON_NAME])
                .output()
                .map(|o| {
                    o.status.success()
                        && output_contains_sha256_fingerprint(
                            &String::from_utf8_lossy(&o.stdout),
                            &self.sha256_fingerprint,
                        )
                })
                .unwrap_or(false)
        }

        #[cfg(target_os = "macos")]
        {
            let args = vec![
                "find-certificate".to_string(),
                "-a".to_string(),
                "-Z".to_string(),
                "-c".to_string(),
                ROOT_CA_COMMON_NAME.to_string(),
            ];
            matches!(
                run_command_with_timeout("security", &args, OS_PRIVILEGE_COMMAND_TIMEOUT),
                Ok(CommandExecutionOutcome::Completed {
                    success: true,
                    stdout,
                    ..
                }) if output_contains_sha256_fingerprint(&stdout, &self.sha256_fingerprint)
            )
        }

        #[cfg(target_os = "linux")]
        {
            let paths: Vec<&Path> = LINUX_ALL_CA_CERT_PATHS.iter().map(Path::new).collect();
            is_installed_in_linux_anchor_paths(&paths, &self.ca_der)
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            false
        }
    }

    /// Returns the public Root CA certificate in PEM text format (`.crt` / `.pem`).
    pub fn root_ca_pem(&self) -> &str {
        &self.ca_pem
    }

    /// Returns the public Root CA certificate in raw DER binary format (`.der` / `.cer`).
    pub fn root_ca_der(&self) -> &[u8] {
        &self.ca_der
    }

    /// Generates an Apple Configuration Profile (`.mobileconfig` XML Property List) embedding
    /// the public Root CA (`com.apple.security.root`) for 1-click installation in iOS / iPadOS Safari.
    pub fn root_ca_mobileconfig(&self) -> String {
        let hex_clean: String = self
            .sha256_fingerprint
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect();
        let padded = format!("{hex_clean:0<64}");

        let outer_uuid = format!(
            "{}-{}-4{}-8{}-{}",
            &padded[0..8],
            &padded[8..12],
            &padded[13..16],
            &padded[17..20],
            &padded[20..32]
        );
        let cert_uuid = format!(
            "{}-{}-4{}-8{}-{}",
            &padded[32..40],
            &padded[40..44],
            &padded[45..48],
            &padded[49..52],
            &padded[52..64]
        );

        let b64_raw = base64::engine::general_purpose::STANDARD.encode(&self.ca_der);
        let b64_wrapped = b64_raw
            .as_bytes()
            .chunks(64)
            .map(|line| format!("\t\t\t\t{}", std::str::from_utf8(line).unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("\n");

        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>fluxproxy-root-ca.cer</string>
			<key>PayloadContent</key>
			<data>
{b64_wrapped}
			</data>
			<key>PayloadDescription</key>
			<string>FluxProxy Local Debugging Root CA Certificate</string>
			<key>PayloadDisplayName</key>
			<string>FluxProxy Local Debugging Root CA</string>
			<key>PayloadIdentifier</key>
			<string>dev.fluxproxy.profile.rootca.cert</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>{cert_uuid}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Installs the FluxProxy Root Certificate Authority for HTTPS/WSS inspection. After installation, enable full trust in Settings &gt; General &gt; About &gt; Certificate Trust Settings.</string>
	<key>PayloadDisplayName</key>
	<string>FluxProxy Local Debugging Root CA</string>
	<key>PayloadIdentifier</key>
	<string>dev.fluxproxy.profile.rootca</string>
	<key>PayloadOrganization</key>
	<string>FluxProxy Web Debugger</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>{outer_uuid}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
"#
        )
    }

    /// Fast lock-free cache lookup for a previously generated per-host TLS `ServerConfig`.
    pub fn cached_server_config_for_host(&self, host: &str) -> Option<Arc<ServerConfig>> {
        let normalized_host = host.trim().to_ascii_lowercase();
        self.leaf_cache.get(&normalized_host)
    }

    fn build_leaf_server_config(&self, normalized_host: &str) -> Result<Arc<ServerConfig>, ProxyError> {
        #[cfg(test)]
        self.leaf_gen_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let mut params = CertificateParams::default();
        params.use_authority_key_identifier_extension = true;

        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, normalized_host.to_string());
        params.distinguished_name = dn;

        if let Ok(ip) = normalized_host.parse::<IpAddr>() {
            params.subject_alt_names = vec![SanType::IpAddress(ip)];
        } else {
            let ia5 = normalized_host
                .to_string()
                .try_into()
                .map_err(|e| ProxyError::Custom(format!("Invalid DNS host '{normalized_host}': {e}")))?;
            params.subject_alt_names = vec![SanType::DnsName(ia5)];
        }

        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];

        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::hours(24);
        params.not_after = now + Duration::days(365);

        let leaf_key = KeyPair::generate()?;
        let leaf_cert = params.signed_by(&leaf_key, &self.ca_cert, &self.ca_key)?;

        let cert_der = CertificateDer::from(leaf_cert.der().to_vec());
        let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der()));

        let mut server_config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert_der], key_der)?;

        // Advertise HTTP/2 and HTTP/1.1 over TLS ALPN
        server_config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];

        Ok(Arc::new(server_config))
    }

    /// Returns a cached or freshly signed TLS `ServerConfig` for the target authority host
    /// using coalescing singleflight (`try_get_with`), advertising both `h2` and `http/1.1` via ALPN.
    pub fn server_config_for_host(&self, host: &str) -> Result<Arc<ServerConfig>, ProxyError> {
        let normalized_host = host.trim().to_ascii_lowercase();
        self.leaf_cache
            .try_get_with(normalized_host.clone(), || {
                self.build_leaf_server_config(&normalized_host)
            })
            .map_err(|arc_err| match Arc::try_unwrap(arc_err) {
                Ok(err) => err,
                Err(shared) => ProxyError::Custom(shared.to_string()),
            })
    }

    pub(crate) fn manual_install_command_for_os_and_store(
        &self,
        target_os: &str,
        linux_store: Option<LinuxCaStoreKind>,
    ) -> String {
        let pem = self.cert_pem_path.display().to_string();
        let cer = self.cert_cer_path.display().to_string();
        match target_os {
            "windows" => format!(
                "certutil -user -addstore Root {}",
                shell_quote_windows(&cer)
            ),
            "macos" => format!(
                "security add-trusted-cert -d -r trustRoot -k \"$HOME/Library/Keychains/login.keychain-db\" {}",
                shell_quote_posix(&pem)
            ),
            "linux" => {
                let store = linux_store.unwrap_or(LinuxCaStoreKind::DebianUpdateCaCertificates);
                let quoted_pem = shell_quote_posix(&pem);
                match store {
                    LinuxCaStoreKind::DebianUpdateCaCertificates => format!(
                        "sudo cp {quoted_pem} {LINUX_DEBIAN_CA_CERT_PATH} && sudo update-ca-certificates"
                    ),
                    LinuxCaStoreKind::RedHatUpdateCaTrust => format!(
                        "sudo cp {quoted_pem} {LINUX_REDHAT_CA_CERT_PATH} && sudo update-ca-trust extract"
                    ),
                    LinuxCaStoreKind::ArchTrustAnchor => format!(
                        "sudo cp {quoted_pem} {LINUX_ARCH_CA_CERT_PATH} && sudo trust anchor --store {LINUX_ARCH_CA_CERT_PATH} && sudo trust extract-compat"
                    ),
                }
            }
            _ => pem,
        }
    }

    pub(crate) fn install_command_spec_for_os_and_store(
        &self,
        target_os: &str,
        linux_store: Option<LinuxCaStoreKind>,
    ) -> Result<OsCommandSpec, ProxyError> {
        let pem = self.cert_pem_path.display().to_string();
        let cer = self.cert_cer_path.display().to_string();
        match target_os {
            "windows" => Ok(OsCommandSpec {
                program: "certutil".into(),
                args: vec!["-user".into(), "-addstore".into(), "Root".into(), cer],
                success_message:
                    "Root CA installed into Windows CurrentUser Trusted Root Store.".into(),
            }),
            "macos" => {
                let home = std::env::var("HOME").unwrap_or_default();
                let login_keychain = format!("{home}/Library/Keychains/login.keychain-db");
                Ok(OsCommandSpec {
                    program: "security".into(),
                    args: vec![
                        "add-trusted-cert".into(),
                        "-d".into(),
                        "-r".into(),
                        "trustRoot".into(),
                        "-k".into(),
                        login_keychain,
                        pem,
                    ],
                    success_message: "Root CA installed into macOS login keychain.".into(),
                })
            }
            "linux" => {
                let Some(store) = linux_store else {
                    let manual_cmd = self.manual_install_command_for_os_and_store("linux", None);
                    return Err(ProxyError::Custom(format!(
                        "Не найдена поддерживаемая утилита системного доверия Linux (update-ca-certificates / update-ca-trust / trust).\nКоманда для ручной установки в терминале:\n{manual_cmd}"
                    )));
                };
                let (script, success_msg) = match store {
                    LinuxCaStoreKind::DebianUpdateCaCertificates => (
                        "mkdir -p /usr/local/share/ca-certificates && cp \"$1\" \"$2\" && update-ca-certificates",
                        "Root CA installed via update-ca-certificates.",
                    ),
                    LinuxCaStoreKind::RedHatUpdateCaTrust => (
                        "mkdir -p /etc/pki/ca-trust/source/anchors && cp \"$1\" \"$2\" && update-ca-trust extract",
                        "Root CA installed via update-ca-trust extract.",
                    ),
                    LinuxCaStoreKind::ArchTrustAnchor => (
                        "mkdir -p /etc/ca-certificates/trust-source/anchors && cp \"$1\" \"$2\" && (trust anchor --store \"$2\" 2>/dev/null || true) && trust extract-compat",
                        "Root CA installed via trust anchor / extract-compat.",
                    ),
                };
                Ok(OsCommandSpec {
                    program: "pkexec".into(),
                    args: vec![
                        "sh".into(),
                        "-c".into(),
                        script.into(),
                        "_".into(),
                        pem,
                        store.cert_path().into(),
                    ],
                    success_message: success_msg.into(),
                })
            }
            _ => Err(ProxyError::Custom(
                "Automatic OS trust store installation is not supported on this platform.".into(),
            )),
        }
    }

    pub(crate) fn install_with_executor_and_store<F>(
        &self,
        target_os: &str,
        linux_store: Option<LinuxCaStoreKind>,
        mut executor: F,
    ) -> Result<String, ProxyError>
    where
        F: FnMut(&str, &[String]) -> Result<CommandExecutionOutcome, std::io::Error>,
    {
        let spec = self.install_command_spec_for_os_and_store(target_os, linux_store)?;
        let manual_cmd = self.manual_install_command_for_os_and_store(target_os, linux_store);
        let outcome = match executor(&spec.program, &spec.args) {
            Ok(out) => out,
            Err(err) if target_os == "linux" && err.kind() == std::io::ErrorKind::NotFound => {
                match executor("sh", &spec.args[1..]) {
                    Ok(out) => out,
                    Err(sh_err) => {
                        return Err(ProxyError::Custom(format!(
                            "Автоматическая установка завершилась ошибкой ({sh_err}).\nКоманда для ручной установки в терминале:\n{manual_cmd}"
                        )));
                    }
                }
            }
            Err(err) => {
                return Err(ProxyError::Custom(format!(
                    "Не удалось запустить '{}': {err}.\nКоманда для ручной установки в терминале:\n{manual_cmd}",
                    spec.program
                )));
            }
        };

        match outcome {
            CommandExecutionOutcome::Completed {
                success: true, ..
            } => Ok(spec.success_message),
            CommandExecutionOutcome::Completed {
                success: false,
                stdout,
                stderr,
            } => {
                let detail = format_command_error(
                    &stderr,
                    &stdout,
                    "Не удалось установить Root CA в хранилище ОС.",
                );
                Err(ProxyError::Custom(format!(
                    "Автоматическая установка не выполнена ({detail}).\nКоманда для ручной установки в терминале:\n{manual_cmd}"
                )))
            }
            CommandExecutionOutcome::TimedOut {
                timeout_secs,
                stdout,
                stderr,
            } => {
                let extra = format_command_error(&stderr, &stdout, "");
                let extra_note = if extra.is_empty() {
                    String::new()
                } else {
                    format!(" ({extra})")
                };
                Err(ProxyError::Custom(format!(
                    "Превышен таймаут ожидания подтверждения привилегий ({timeout_secs} с): процесс '{}' принудительно завершён{extra_note}.\nКоманда для ручной установки в терминале:\n{manual_cmd}",
                    spec.program
                )))
            }
        }
    }

    /// Triggers explicit, OS-prompted installation of the local Root CA into the current user's trust store.
    pub fn install_into_os_trust_store(&self) -> Result<String, ProxyError> {
        #[cfg(target_os = "linux")]
        let linux_store = detect_linux_ca_store();
        #[cfg(not(target_os = "linux"))]
        let linux_store: Option<LinuxCaStoreKind> = None;

        self.install_with_executor_and_store(std::env::consts::OS, linux_store, |program, args| {
            run_command_with_timeout(program, args, OS_PRIVILEGE_COMMAND_TIMEOUT)
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn uninstall_command_spec_for_os(target_os: &str) -> Result<OsCommandSpec, ProxyError> {
        Self::uninstall_command_spec_for_os_and_store(
            target_os,
            Some(LinuxCaStoreKind::DebianUpdateCaCertificates),
        )
    }

    pub(crate) fn uninstall_command_spec_for_os_and_store(
        target_os: &str,
        linux_store: Option<LinuxCaStoreKind>,
    ) -> Result<OsCommandSpec, ProxyError> {
        match target_os {
            "windows" => Ok(OsCommandSpec {
                program: "certutil".into(),
                args: vec![
                    "-user".into(),
                    "-delstore".into(),
                    "Root".into(),
                    ROOT_CA_COMMON_NAME.into(),
                ],
                success_message:
                    "Root CA removed from Windows CurrentUser Trusted Root Store.".into(),
            }),
            "macos" => Ok(OsCommandSpec {
                program: "security".into(),
                args: vec![
                    "delete-certificate".into(),
                    "-c".into(),
                    ROOT_CA_COMMON_NAME.into(),
                ],
                success_message: "Root CA removed from macOS keychain.".into(),
            }),
            "linux" => {
                let store = linux_store.ok_or_else(|| {
                    ProxyError::Custom(
                        "Не найдена поддерживаемая утилита удаления сертификата Linux.".into(),
                    )
                })?;
                let (script, success_msg) = match store {
                    LinuxCaStoreKind::DebianUpdateCaCertificates => (
                        format!("rm -f \"$1\" && update-ca-certificates --fresh # {LINUX_DEBIAN_CA_CERT_PATH}"),
                        "Root CA removed from /usr/local/share/ca-certificates/ via update-ca-certificates --fresh.",
                    ),
                    LinuxCaStoreKind::RedHatUpdateCaTrust => (
                        format!("rm -f \"$1\" && update-ca-trust extract # {LINUX_REDHAT_CA_CERT_PATH}"),
                        "Root CA removed from /etc/pki/ca-trust/source/anchors/ via update-ca-trust extract.",
                    ),
                    LinuxCaStoreKind::ArchTrustAnchor => (
                        format!("(trust anchor --remove \"$1\" 2>/dev/null || true) && rm -f \"$1\" && trust extract-compat # {LINUX_ARCH_CA_CERT_PATH}"),
                        "Root CA removed from /etc/ca-certificates/trust-source/anchors/ via trust extract-compat.",
                    ),
                };
                Ok(OsCommandSpec {
                    program: "pkexec".into(),
                    args: vec![
                        "sh".into(),
                        "-c".into(),
                        script,
                        "_".into(),
                        store.cert_path().into(),
                    ],
                    success_message: success_msg.into(),
                })
            }
            other => Err(ProxyError::Custom(format!(
                "Automatic OS trust store uninstallation is not supported on '{other}'."
            ))),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn uninstall_with_executor<F>(
        &self,
        target_os: &str,
        mut executor: F,
    ) -> Result<String, ProxyError>
    where
        F: FnMut(&str, &[String]) -> Result<(bool, String, String), std::io::Error>,
    {
        self.uninstall_with_executor_and_store(
            target_os,
            Some(LinuxCaStoreKind::DebianUpdateCaCertificates),
            |program, args| match executor(program, args) {
                Ok((success, stdout, stderr)) => Ok(CommandExecutionOutcome::Completed {
                    success,
                    stdout,
                    stderr,
                }),
                Err(err) => Err(err),
            },
        )
    }

    pub(crate) fn uninstall_with_executor_and_store<F>(
        &self,
        target_os: &str,
        linux_store: Option<LinuxCaStoreKind>,
        mut executor: F,
    ) -> Result<String, ProxyError>
    where
        F: FnMut(&str, &[String]) -> Result<CommandExecutionOutcome, std::io::Error>,
    {
        let spec = Self::uninstall_command_spec_for_os_and_store(target_os, linux_store)?;
        let outcome = match executor(&spec.program, &spec.args) {
            Ok(out) => out,
            Err(err) if target_os == "linux" && err.kind() == std::io::ErrorKind::NotFound => {
                let store = linux_store.unwrap_or(LinuxCaStoreKind::DebianUpdateCaCertificates);
                let cert_path = store.cert_path();
                if matches!(store, LinuxCaStoreKind::ArchTrustAnchor) {
                    let remove_args = vec![
                        "anchor".to_string(),
                        "--remove".to_string(),
                        cert_path.to_string(),
                    ];
                    let _ = executor("trust", &remove_args);
                }
                match fs::remove_file(cert_path) {
                    Ok(()) => {}
                    Err(rm_err) if rm_err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(rm_err) => return Err(ProxyError::Io(rm_err)),
                }
                let (direct_prog, direct_args) = match store {
                    LinuxCaStoreKind::DebianUpdateCaCertificates => (
                        "update-ca-certificates",
                        vec!["--fresh".to_string()],
                    ),
                    LinuxCaStoreKind::RedHatUpdateCaTrust => (
                        "update-ca-trust",
                        vec!["extract".to_string()],
                    ),
                    LinuxCaStoreKind::ArchTrustAnchor => (
                        "trust",
                        vec!["extract-compat".to_string()],
                    ),
                };
                executor(direct_prog, &direct_args)?
            }
            Err(err) => return Err(ProxyError::Io(err)),
        };

        match outcome {
            CommandExecutionOutcome::Completed {
                success: true, ..
            } => Ok(spec.success_message),
            CommandExecutionOutcome::Completed {
                success: false,
                stdout,
                stderr,
            } => Err(ProxyError::Custom(format_command_error(
                &stderr,
                &stdout,
                "Failed to remove Root CA from OS trust store.",
            ))),
            CommandExecutionOutcome::TimedOut { timeout_secs, .. } => Err(ProxyError::Custom(format!(
                "Превышен таймаут удаления Root CA ({timeout_secs} с): процесс '{}' принудительно завершён.",
                spec.program
            ))),
        }
    }

    /// Removes the local FluxProxy Root CA certificate from the OS trust store.
    pub fn uninstall_from_os_trust_store(&self) -> Result<String, ProxyError> {
        #[cfg(target_os = "linux")]
        let linux_store = detect_linux_ca_store();
        #[cfg(not(target_os = "linux"))]
        let linux_store: Option<LinuxCaStoreKind> = None;

        self.uninstall_with_executor_and_store(std::env::consts::OS, linux_store, |program, args| {
            run_command_with_timeout(program, args, OS_PRIVILEGE_COMMAND_TIMEOUT)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_pem_der_and_ios_mobileconfig_profile() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_mobile_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);

        let ca = CertificateAuthority::init_or_load(&dir).expect("init CA");
        assert!(ca.root_ca_pem().contains("-----BEGIN CERTIFICATE-----"));
        assert!(!ca.root_ca_der().is_empty());
        assert!(ca.key_pem_path().ends_with("fluxproxy-root-ca.key"));
        assert!(ca.key_pem_path().exists());

        let profile = ca.root_ca_mobileconfig();
        assert!(profile.contains("<!DOCTYPE plist"));
        assert!(profile.contains("<string>com.apple.security.root</string>"));
        assert!(profile.contains("<string>Configuration</string>"));
        assert!(profile.contains("FluxProxy Local Debugging Root CA"));

        // Verify Base64 payload decodes back to the exact Root CA DER bytes
        let data_start = profile.find("<data>").expect("data start") + "<data>".len();
        let data_end = profile.find("</data>").expect("data end");
        let b64_compact: String = profile[data_start..data_end]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64_compact)
            .expect("valid base64 in mobileconfig");
        assert_eq!(decoded, ca.root_ca_der());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_fluxproxy_root_ca_key_and_migrates_legacy_key_file() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_key_migration_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);

        let ca1 = CertificateAuthority::init_or_load(&dir).expect("first CA init");
        let fp1 = ca1.info().sha256_fingerprint;
        let key_path = dir.join("ca").join("fluxproxy-root-ca.key");
        let legacy_path = dir.join("ca").join("fluxproxy-root-ca-key.pem");
        assert!(key_path.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&key_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "fluxproxy-root-ca.key must have 0600 permissions");
        }

        // Simulate a legacy installation having `fluxproxy-root-ca-key.pem` instead of `.key`
        fs::rename(&key_path, &legacy_path).expect("rename to legacy key");
        assert!(!key_path.exists());
        assert!(legacy_path.exists());

        let ca2 = CertificateAuthority::init_or_load(&dir).expect("migrated CA load");
        assert_eq!(ca2.info().sha256_fingerprint, fp1);
        assert!(key_path.exists());
        assert!(!legacy_path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_os_trust_store_uninstall_commands_and_handles_execution_results() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_uninstall_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let ca = CertificateAuthority::init_or_load(&dir).expect("init CA");

        // 1. Windows command spec (`certutil -user -delstore Root "FluxProxy Local Debugging Root CA"`)
        let win_spec =
            CertificateAuthority::uninstall_command_spec_for_os("windows").expect("windows spec");
        assert_eq!(win_spec.program, "certutil");
        assert_eq!(
            win_spec.args,
            vec![
                "-user",
                "-delstore",
                "Root",
                "FluxProxy Local Debugging Root CA"
            ]
        );

        // 2. macOS command spec (`security delete-certificate -c "FluxProxy Local Debugging Root CA"`)
        let mac_spec =
            CertificateAuthority::uninstall_command_spec_for_os("macos").expect("macos spec");
        assert_eq!(mac_spec.program, "security");
        assert_eq!(
            mac_spec.args,
            vec![
                "delete-certificate",
                "-c",
                "FluxProxy Local Debugging Root CA"
            ]
        );

        // 3. Linux command spec (`/usr/local/share/ca-certificates/` + `update-ca-certificates --fresh`)
        let linux_spec =
            CertificateAuthority::uninstall_command_spec_for_os("linux").expect("linux spec");
        assert_eq!(linux_spec.program, "pkexec");
        assert!(linux_spec.args[2].contains("/usr/local/share/ca-certificates/fluxproxy-root-ca.crt"));
        assert!(linux_spec.args[2].contains("update-ca-certificates --fresh"));

        // 4. Verify executor success & error handling across Windows/macOS/Linux
        let ok_msg = ca
            .uninstall_with_executor("windows", |prog, args| {
                assert_eq!(prog, "certutil");
                assert_eq!(args[1], "-delstore");
                Ok((true, "CertUtil: -delstore command completed successfully.".into(), String::new()))
            })
            .expect("windows uninstall success");
        assert!(ok_msg.contains("Windows"));

        let err_res = ca.uninstall_with_executor("macos", |prog, _args| {
            assert_eq!(prog, "security");
            Ok((
                false,
                String::new(),
                "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.".into(),
            ))
        });
        assert!(err_res.is_err());
        assert!(err_res
            .unwrap_err()
            .to_string()
            .contains("could not be found"));

        // 5. Verify Linux fallback when `pkexec` is NotFound
        let mut calls: Vec<String> = Vec::new();
        let linux_ok = ca
            .uninstall_with_executor("linux", |prog, args| {
                calls.push(format!("{prog} {}", args.join(" ")));
                if prog == "pkexec" {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "pkexec not installed",
                    ))
                } else {
                    Ok((true, "Updating certificates in /etc/ssl/certs...".into(), String::new()))
                }
            })
            .expect("linux fallback success");
        assert!(linux_ok.contains("update-ca-certificates --fresh"));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1], "update-ca-certificates --fresh");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reload_preserves_exact_ca_der_rebuilds_corrupted_cer_and_parses_real_valid_until() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_reload_consistency_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);

        let ca1 = CertificateAuthority::init_or_load(&dir).expect("init CA");
        let info1 = ca1.info();
        assert_ne!(info1.valid_until, "10 years (Local Root CA)");
        assert!(info1.valid_until.ends_with(" UTC"));
        let expected_year = (OffsetDateTime::now_utc() + Duration::days(3650))
            .year()
            .to_string();
        assert!(
            info1.valid_until.starts_with(&expected_year),
            "expected valid_until year {expected_year}, got {}",
            info1.valid_until
        );

        let pem_path = dir.join("ca").join("fluxproxy-root-ca.pem");
        let cer_path = dir.join("ca").join("fluxproxy-root-ca.cer");

        // Corrupt `.cer` and verify reload repairs it strictly from the persisted `.pem`
        fs::write(&cer_path, b"corrupted-cer-bytes").expect("corrupt cer");
        let ca2 = CertificateAuthority::init_or_load(&dir).expect("reload CA with corrupted cer");
        assert_eq!(ca2.root_ca_der(), ca1.root_ca_der());
        assert_eq!(ca2.root_ca_pem(), ca1.root_ca_pem());
        assert_eq!(ca2.info().sha256_fingerprint, info1.sha256_fingerprint);
        assert_eq!(ca2.info().valid_until, info1.valid_until);
        assert_eq!(fs::read(&cer_path).unwrap(), ca1.root_ca_der());

        // Delete `.pem` and verify reload recovers `.pem` from `.cer` preserving fingerprint
        fs::remove_file(&pem_path).expect("remove pem");
        let ca3 = CertificateAuthority::init_or_load(&dir).expect("reload CA from cer");
        assert_eq!(ca3.root_ca_der(), ca1.root_ca_der());
        assert_eq!(ca3.info().sha256_fingerprint, info1.sha256_fingerprint);
        assert!(pem_path.exists());

        // Minting a leaf cert still succeeds with reloaded CA
        let _leaf = ca3
            .server_config_for_host("reloaded.fluxproxy.test")
            .expect("sign leaf cert after CA reload");

        // Verify Linux trust matcher compares contents/digest rather than mere file existence
        assert!(cert_file_matches_ca_der(
            ca1.root_ca_pem().as_bytes(),
            ca1.root_ca_der()
        ));
        assert!(cert_file_matches_ca_der(
            ca1.root_ca_der(),
            ca1.root_ca_der()
        ));

        let other_dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_other_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&other_dir);
        let other_ca = CertificateAuthority::init_or_load(&other_dir).expect("init other CA");
        assert!(!cert_file_matches_ca_der(
            other_ca.root_ca_pem().as_bytes(),
            ca1.root_ca_der()
        ));
        assert!(!cert_file_matches_ca_der(b"not a cert", ca1.root_ca_der()));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other_dir);
    }

    #[test]
    fn output_contains_sha256_fingerprint_matches_windows_certutil_and_macos_security() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_fp_match_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let ca = CertificateAuthority::init_or_load(&dir).expect("init CA");
        let active_fp = &ca.info().sha256_fingerprint;
        let hex_lower: String = active_fp
            .chars()
            .filter(|c| c.is_ascii_hexdigit())
            .map(|c| c.to_ascii_lowercase())
            .collect();
        let hex_upper = hex_lower.to_ascii_uppercase();
        let wrong_hex = "0".repeat(64);
        assert_eq!(hex_lower.len(), 64);

        // Windows `certutil -user -store -v Root "FluxProxy Local Debugging Root CA"`
        let certutil_ok = format!(
            "================ Certificate 0 ================\r\n\
             Serial Number: 1234abcd\r\n\
             Issuer: CN=FluxProxy Local Debugging Root CA\r\n\
             Cert Hash(sha1): deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\r\n\
             Cert Hash(sha256): {hex_lower}\r\n"
        );
        assert!(output_contains_sha256_fingerprint(&certutil_ok, active_fp));

        // Non-English Windows localized label should still match by colon-separated SHA-256 hex
        let certutil_localized = format!("Хэш сертификата(sha256): {hex_upper}\r\n");
        assert!(output_contains_sha256_fingerprint(
            &certutil_localized,
            active_fp
        ));

        // Stale CA with same CN but wrong SHA-256 hash or SHA-1 only must NOT match
        let certutil_stale = format!(
            "Cert Hash(sha1): deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\r\n\
             Cert Hash(sha256): {wrong_hex}\r\n"
        );
        assert!(!output_contains_sha256_fingerprint(&certutil_stale, active_fp));
        let certutil_sha1_only = "Cert Hash(sha1): deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\r\n";
        assert!(!output_contains_sha256_fingerprint(
            certutil_sha1_only,
            active_fp
        ));

        // macOS `security find-certificate -a -Z -c "FluxProxy Local Debugging Root CA"`
        // Multiple certs with the same CN: first stale, second active
        let security_multi = format!(
            "SHA-256 hash: {wrong_hex}\n\
             SHA-1 hash: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\
             keychain: \"/Library/Keychains/System.keychain\"\n\
             SHA-256 hash: {hex_upper}\n"
        );
        assert!(output_contains_sha256_fingerprint(
            &security_multi,
            active_fp
        ));

        let security_stale = format!("SHA-256 hash: {wrong_hex}\n");
        assert!(!output_contains_sha256_fingerprint(
            &security_stale,
            active_fp
        ));
        assert!(!output_contains_sha256_fingerprint("", "short"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn encrypts_ca_key_with_dpapi_and_migrates_legacy_plain_pem() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_dpapi_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);

        let ca1 = CertificateAuthority::init_or_load(&dir).expect("init CA");
        let fp1 = ca1.info().sha256_fingerprint;
        let key_path = ca1.key_pem_path().to_path_buf();

        let disk_after_init = fs::read_to_string(&key_path).unwrap();
        assert!(disk_after_init.starts_with(crate::proxy::dpapi::DPAPI_PREFIX));
        assert!(!disk_after_init.contains("-----BEGIN"));

        // Reload encrypted CA key
        let ca2 = CertificateAuthority::init_or_load(&dir).expect("reload DPAPI CA");
        assert_eq!(ca2.info().sha256_fingerprint, fp1);

        // Overwrite with legacy plain PEM and verify transparent migration on reload
        let plain_key_pem = ca1.ca_key.serialize_pem();
        fs::write(&key_path, plain_key_pem.as_bytes()).unwrap();
        assert!(fs::read_to_string(&key_path)
            .unwrap()
            .starts_with("-----BEGIN"));

        let ca3 = CertificateAuthority::init_or_load(&dir).expect("migrate legacy plain PEM CA");
        assert_eq!(ca3.info().sha256_fingerprint, fp1);
        let disk_after_migration = fs::read_to_string(&key_path).unwrap();
        assert!(disk_after_migration.starts_with(crate::proxy::dpapi::DPAPI_PREFIX));
        assert!(!disk_after_migration.contains("-----BEGIN"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_debian_redhat_and_arch_linux_ca_stores() {
        assert_eq!(
            detect_linux_ca_store_with(
                |d| d == LINUX_DEBIAN_CA_DIR,
                |b| b == "update-ca-certificates",
            ),
            Some(LinuxCaStoreKind::DebianUpdateCaCertificates)
        );
        // Fedora/RHEL ships both `update-ca-trust` and p11-kit `trust`
        assert_eq!(
            detect_linux_ca_store_with(
                |d| d == LINUX_REDHAT_CA_DIR,
                |b| b == "update-ca-trust" || b == "trust",
            ),
            Some(LinuxCaStoreKind::RedHatUpdateCaTrust)
        );
        assert_eq!(
            detect_linux_ca_store_with(
                |d| d == LINUX_ARCH_CA_DIR,
                |b| b == "trust",
            ),
            Some(LinuxCaStoreKind::ArchTrustAnchor)
        );
        assert_eq!(detect_linux_ca_store_with(|_| false, |_| false), None);

        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_linux_anchors_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let ca = CertificateAuthority::init_or_load(&dir).expect("init CA");
        let missing_a = dir.join("missing-debian.crt");
        let arch_file = dir.join("arch-anchor.crt");
        fs::write(&arch_file, ca.root_ca_pem().as_bytes()).unwrap();
        assert!(is_installed_in_linux_anchor_paths(
            &[missing_a.as_path(), arch_file.as_path()],
            ca.root_ca_der(),
        ));
        fs::write(&arch_file, b"stale-cert").unwrap();
        assert!(!is_installed_in_linux_anchor_paths(
            &[missing_a.as_path(), arch_file.as_path()],
            ca.root_ca_der(),
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_install_uninstall_and_manual_cli_specs_for_all_linux_stores_and_macos() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_specs_all_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let ca = CertificateAuthority::init_or_load(&dir).expect("init CA");

        // 1. Debian, RedHat/Fedora, Arch install specs & manual commands
        let deb_spec = ca
            .install_command_spec_for_os_and_store(
                "linux",
                Some(LinuxCaStoreKind::DebianUpdateCaCertificates),
            )
            .unwrap();
        assert_eq!(deb_spec.program, "pkexec");
        assert!(deb_spec.args[2].contains("update-ca-certificates"));
        assert_eq!(deb_spec.args[5], LINUX_DEBIAN_CA_CERT_PATH);
        let deb_manual = ca.manual_install_command_for_os_and_store(
            "linux",
            Some(LinuxCaStoreKind::DebianUpdateCaCertificates),
        );
        assert!(deb_manual.contains("sudo update-ca-certificates"));

        let rh_spec = ca
            .install_command_spec_for_os_and_store(
                "linux",
                Some(LinuxCaStoreKind::RedHatUpdateCaTrust),
            )
            .unwrap();
        assert!(rh_spec.args[2].contains("update-ca-trust extract"));
        assert_eq!(rh_spec.args[5], LINUX_REDHAT_CA_CERT_PATH);
        let rh_manual = ca.manual_install_command_for_os_and_store(
            "linux",
            Some(LinuxCaStoreKind::RedHatUpdateCaTrust),
        );
        assert!(rh_manual.contains("/etc/pki/ca-trust/source/anchors/"));
        assert!(rh_manual.contains("update-ca-trust extract"));

        let arch_spec = ca
            .install_command_spec_for_os_and_store(
                "linux",
                Some(LinuxCaStoreKind::ArchTrustAnchor),
            )
            .unwrap();
        assert!(arch_spec.args[2].contains("trust anchor --store"));
        assert!(arch_spec.args[2].contains("trust extract-compat"));
        assert_eq!(arch_spec.args[5], LINUX_ARCH_CA_CERT_PATH);
        let arch_manual = ca.manual_install_command_for_os_and_store(
            "linux",
            Some(LinuxCaStoreKind::ArchTrustAnchor),
        );
        assert!(arch_manual.contains("/etc/ca-certificates/trust-source/anchors/"));
        assert!(arch_manual.contains("trust anchor --store"));

        // 2. RedHat & Arch uninstall specs
        let rh_uninst = CertificateAuthority::uninstall_command_spec_for_os_and_store(
            "linux",
            Some(LinuxCaStoreKind::RedHatUpdateCaTrust),
        )
        .unwrap();
        assert!(rh_uninst.args[2].contains("update-ca-trust extract"));
        let arch_uninst = CertificateAuthority::uninstall_command_spec_for_os_and_store(
            "linux",
            Some(LinuxCaStoreKind::ArchTrustAnchor),
        )
        .unwrap();
        assert!(arch_uninst.args[2].contains("trust anchor --remove"));
        assert!(arch_uninst.args[2].contains("trust extract-compat"));

        // 3. Timeout and failure include manual CLI command
        let timeout_err = ca
            .install_with_executor_and_store("macos", None, |prog, _args| {
                assert_eq!(prog, "security");
                Ok(CommandExecutionOutcome::TimedOut {
                    timeout_secs: 60,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            })
            .unwrap_err()
            .to_string();
        assert!(timeout_err.contains("60 с"));
        assert!(timeout_err.contains("security add-trusted-cert"));

        let fail_err = ca
            .install_with_executor_and_store(
                "linux",
                Some(LinuxCaStoreKind::RedHatUpdateCaTrust),
                |_prog, _args| {
                    Ok(CommandExecutionOutcome::Completed {
                        success: false,
                        stdout: String::new(),
                        stderr: "No PolKit authentication agent found".into(),
                    })
                },
            )
            .unwrap_err()
            .to_string();
        assert!(fail_err.contains("update-ca-trust extract"));

        // 4. Direct `sh` fallback when `pkexec` is NotFound
        let mut invoked_programs = Vec::new();
        let fallback_ok = ca
            .install_with_executor_and_store(
                "linux",
                Some(LinuxCaStoreKind::ArchTrustAnchor),
                |prog, _args| {
                    invoked_programs.push(prog.to_string());
                    if prog == "pkexec" {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::NotFound,
                            "pkexec missing",
                        ))
                    } else {
                        Ok(CommandExecutionOutcome::Completed {
                            success: true,
                            stdout: String::new(),
                            stderr: String::new(),
                        })
                    }
                },
            )
            .expect("sh fallback succeeds");
        assert!(fallback_ok.contains("trust anchor"));
        assert_eq!(invoked_programs, vec!["pkexec", "sh"]);

        let info = ca.info();
        assert!(info.manual_install_command.is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_command_with_timeout_kills_hanging_process_and_returns_timed_out() {
        #[cfg(target_os = "windows")]
        let (hang_prog, hang_args, ok_prog, ok_args) = (
            "ping",
            vec!["-n".to_string(), "15".to_string(), "127.0.0.1".to_string()],
            "cmd",
            vec!["/C".to_string(), "echo flux-ca-ok".to_string()],
        );
        #[cfg(not(target_os = "windows"))]
        let (hang_prog, hang_args, ok_prog, ok_args) = (
            "sleep",
            vec!["10".to_string()],
            "sh",
            vec!["-c".to_string(), "echo flux-ca-ok".to_string()],
        );

        let started = std::time::Instant::now();
        let outcome = run_command_with_timeout(
            hang_prog,
            &hang_args,
            std::time::Duration::from_millis(200),
        )
        .expect("spawn hanging process");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "process kill on timeout took too long: {:?}",
            started.elapsed()
        );
        assert!(
            matches!(outcome, CommandExecutionOutcome::TimedOut { .. }),
            "expected TimedOut, got {outcome:?}"
        );

        let ok_outcome = run_command_with_timeout(
            ok_prog,
            &ok_args,
            std::time::Duration::from_secs(5),
        )
        .expect("spawn fast process");
        match ok_outcome {
            CommandExecutionOutcome::Completed {
                success, stdout, ..
            } => {
                assert!(success);
                assert!(stdout.contains("flux-ca-ok"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn server_config_for_host_coalesces_concurrent_leaf_generation() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_ca_singleflight_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let ca = Arc::new(CertificateAuthority::init_or_load(&dir).expect("init CA"));

        let barrier = Arc::new(std::sync::Barrier::new(16));
        let mut handles = Vec::with_capacity(16);
        for _ in 0..16 {
            let ca_ref = Arc::clone(&ca);
            let b = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                b.wait();
                ca_ref
                    .server_config_for_host("singleflight.fluxproxy.test")
                    .expect("generate leaf cert")
            }));
        }

        let configs: Vec<Arc<ServerConfig>> = handles
            .into_iter()
            .map(|h| h.join().expect("worker join"))
            .collect();
        assert_eq!(
            ca.leaf_gen_count.load(std::sync::atomic::Ordering::Relaxed),
            1,
            "concurrent leaf generation for the same host must coalesce into a single build"
        );
        for cfg in &configs[1..] {
            assert!(Arc::ptr_eq(&configs[0], cfg));
        }

        let cached = ca
            .cached_server_config_for_host("  SINGLEFLIGHT.FLUXPROXY.TEST ")
            .expect("cached entry should exist");
        assert!(Arc::ptr_eq(&configs[0], &cached));

        let _ = fs::remove_dir_all(&dir);
    }
}
