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
use time::{Duration, OffsetDateTime};

use crate::models::{CaCertificateInfo, ProxyError};

pub const ROOT_CA_COMMON_NAME: &str = "FluxProxy Local Debugging Root CA";
const LINUX_SYSTEM_CA_CERT_PATH: &str = "/usr/local/share/ca-certificates/fluxproxy-root-ca.crt";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OsCommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub success_message: String,
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
        file.write_all(pem_contents.as_bytes())?;
        file.sync_all()?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        fs::write(path, pem_contents)
    }
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

        let (ca_cert, ca_key, ca_pem, der_bytes) =
            if cert_pem_path.exists() && (key_pem_path.exists() || legacy_key_pem_path.exists()) {
                let cert_pem = fs::read_to_string(&cert_pem_path)?;
                let key_pem = if key_pem_path.exists() {
                    enforce_private_key_permissions(&key_pem_path)?;
                    if legacy_key_pem_path.exists() {
                        let _ = fs::remove_file(&legacy_key_pem_path);
                    }
                    fs::read_to_string(&key_pem_path)?
                } else {
                    let migrated = fs::read_to_string(&legacy_key_pem_path)?;
                    write_private_key_securely(&key_pem_path, &migrated)?;
                    let _ = fs::remove_file(&legacy_key_pem_path);
                    migrated
                };
                let ca_key = KeyPair::from_pem(&key_pem)?;
                let mut params = CertificateParams::from_ca_cert_pem(&cert_pem)?;
                params.use_authority_key_identifier_extension = true;
                let ca_cert = params.self_signed(&ca_key)?;
                let der = fs::read(&cert_cer_path).unwrap_or_else(|_| ca_cert.der().to_vec());
                (ca_cert, ca_key, cert_pem, der)
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

                let ca_key = KeyPair::generate()?;
                let ca_cert = params.self_signed(&ca_key)?;
                let pem_text = ca_cert.pem();
                let der_bytes = ca_cert.der().to_vec();

                fs::write(&cert_pem_path, &pem_text)?;
                fs::write(&cert_cer_path, &der_bytes)?;
                write_private_key_securely(&key_pem_path, &ca_key.serialize_pem())?;

                (ca_cert, ca_key, pem_text, der_bytes)
            };

        let mut hasher = Sha256::new();
        hasher.update(&der_bytes);
        let digest = hex::encode_upper(hasher.finalize());
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
            valid_until: "10 years (Local Root CA)".to_string(),
            leaf_cache,
        })
    }

    pub fn info(&self) -> CaCertificateInfo {
        CaCertificateInfo {
            cert_pem_path: self.cert_pem_path.display().to_string(),
            cert_cer_path: self.cert_cer_path.display().to_string(),
            sha256_fingerprint: self.sha256_fingerprint.clone(),
            subject: format!("CN={ROOT_CA_COMMON_NAME}, O=FluxProxy Web Debugger"),
            valid_until: self.valid_until.clone(),
            is_trusted: false,
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

    /// Non-destructively checks whether the FluxProxy Root CA is currently present in the OS trust store.
    pub fn is_installed_in_os_trust_store(&self) -> bool {
        #[cfg(target_os = "windows")]
        {
            return new_os_command("certutil")
                .args(["-user", "-store", "Root", ROOT_CA_COMMON_NAME])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
        }

        #[cfg(target_os = "macos")]
        {
            return new_os_command("security")
                .args(["find-certificate", "-c", ROOT_CA_COMMON_NAME])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
        }

        #[cfg(target_os = "linux")]
        {
            return Path::new(LINUX_SYSTEM_CA_CERT_PATH).exists();
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

    /// Returns a cached or freshly signed TLS `ServerConfig` for the target authority host,
    /// advertising both `h2` (HTTP/2) and `http/1.1` via ALPN.
    pub fn server_config_for_host(&self, host: &str) -> Result<Arc<ServerConfig>, ProxyError> {
        let normalized_host = host.trim().to_ascii_lowercase();
        if let Some(cached) = self.leaf_cache.get(&normalized_host) {
            return Ok(cached);
        }

        let mut params = CertificateParams::default();
        params.use_authority_key_identifier_extension = true;

        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, normalized_host.clone());
        params.distinguished_name = dn;

        if let Ok(ip) = normalized_host.parse::<IpAddr>() {
            params.subject_alt_names = vec![SanType::IpAddress(ip)];
        } else {
            let ia5 = normalized_host
                .clone()
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

        let arc_cfg = Arc::new(server_config);
        self.leaf_cache.insert(normalized_host, arc_cfg.clone());
        Ok(arc_cfg)
    }

    /// Triggers explicit, OS-prompted installation of the local Root CA into the current user's trust store.
    pub fn install_into_os_trust_store(&self) -> Result<String, ProxyError> {
        let cert_path = self.cert_cer_path.display().to_string();

        #[cfg(target_os = "windows")]
        {
            // Installs into CurrentUser Root store, triggering Windows' native Security Warning confirmation prompt.
            let output = new_os_command("certutil")
                .args(["-user", "-addstore", "Root", &cert_path])
                .output()?;

            if output.status.success() {
                return Ok("Root CA installed into Windows CurrentUser Trusted Root Store.".into());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(ProxyError::Custom(format_command_error(
                &stderr,
                &stdout,
                "Failed to install Root CA into Windows CurrentUser Root store.",
            )));
        }

        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME").unwrap_or_default();
            let login_keychain = format!("{home}/Library/Keychains/login.keychain-db");
            let output = new_os_command("security")
                .args([
                    "add-trusted-cert",
                    "-d",
                    "-r",
                    "trustRoot",
                    "-k",
                    &login_keychain,
                    &self.cert_pem_path.display().to_string(),
                ])
                .output()?;

            if output.status.success() {
                return Ok("Root CA installed into macOS login keychain.".into());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(ProxyError::Custom(format_command_error(
                &stderr,
                &stdout,
                "Failed to install Root CA into macOS login keychain.",
            )));
        }

        #[cfg(target_os = "linux")]
        {
            let pem_path = self.cert_pem_path.display().to_string();
            let output = new_os_command("pkexec")
                .args([
                    "sh",
                    "-c",
                    &format!(
                        "cp '{}' {LINUX_SYSTEM_CA_CERT_PATH} && update-ca-certificates",
                        pem_path
                    ),
                ])
                .output()?;

            if output.status.success() {
                return Ok("Root CA installed via update-ca-certificates.".into());
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(ProxyError::Custom(format!(
                "Automatic install failed ({}). Import '{}' manually into your browser/OS trust store.",
                format_command_error(&stderr, &stdout, "pkexec error"),
                pem_path
            )));
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = cert_path;
            Err(ProxyError::Custom(
                "Automatic OS trust store installation is not supported on this platform.".into(),
            ))
        }
    }

    pub(crate) fn uninstall_command_spec_for_os(target_os: &str) -> Result<OsCommandSpec, ProxyError> {
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
            "linux" => Ok(OsCommandSpec {
                program: "pkexec".into(),
                args: vec![
                    "sh".into(),
                    "-c".into(),
                    format!(
                        "rm -f {LINUX_SYSTEM_CA_CERT_PATH} && update-ca-certificates --fresh"
                    ),
                ],
                success_message:
                    "Root CA removed from /usr/local/share/ca-certificates/ via update-ca-certificates --fresh.".into(),
            }),
            other => Err(ProxyError::Custom(format!(
                "Automatic OS trust store uninstallation is not supported on '{other}'."
            ))),
        }
    }

    pub(crate) fn uninstall_with_executor<F>(
        &self,
        target_os: &str,
        mut executor: F,
    ) -> Result<String, ProxyError>
    where
        F: FnMut(&str, &[String]) -> Result<(bool, String, String), std::io::Error>,
    {
        let spec = Self::uninstall_command_spec_for_os(target_os)?;
        match executor(&spec.program, &spec.args) {
            Ok((true, _, _)) => Ok(spec.success_message),
            Ok((false, stdout, stderr)) => Err(ProxyError::Custom(format_command_error(
                &stderr,
                &stdout,
                "Failed to remove Root CA from OS trust store.",
            ))),
            Err(err) if target_os == "linux" && err.kind() == std::io::ErrorKind::NotFound => {
                // Fallback for root/container Linux environments without `pkexec`
                match fs::remove_file(LINUX_SYSTEM_CA_CERT_PATH) {
                    Ok(()) => {}
                    Err(rm_err) if rm_err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(rm_err) => return Err(ProxyError::Io(rm_err)),
                }
                let direct_args = vec!["--fresh".to_string()];
                let (ok, stdout, stderr) = executor("update-ca-certificates", &direct_args)?;
                if ok {
                    Ok(spec.success_message)
                } else {
                    Err(ProxyError::Custom(format_command_error(
                        &stderr,
                        &stdout,
                        "update-ca-certificates --fresh failed.",
                    )))
                }
            }
            Err(err) => Err(ProxyError::Io(err)),
        }
    }

    /// Removes the local FluxProxy Root CA certificate from the OS trust store.
    pub fn uninstall_from_os_trust_store(&self) -> Result<String, ProxyError> {
        self.uninstall_with_executor(std::env::consts::OS, |program, args| {
            let output = new_os_command(program).args(args).output()?;
            Ok((
                output.status.success(),
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
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
}
