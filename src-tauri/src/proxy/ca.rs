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

/// Manages the local Root Certificate Authority and caches dynamically minted
/// per-host ECDSA P-256 TLS `ServerConfig` instances for low-latency MITM handshakes.
pub struct CertificateAuthority {
    ca_cert: Certificate,
    ca_key: KeyPair,
    ca_pem: String,
    ca_der: Vec<u8>,
    cert_pem_path: PathBuf,
    cert_cer_path: PathBuf,
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
        let key_pem_path = ca_dir.join("fluxproxy-root-ca-key.pem");

        let (ca_cert, ca_key, ca_pem, der_bytes) = if cert_pem_path.exists() && key_pem_path.exists() {
            let cert_pem = fs::read_to_string(&cert_pem_path)?;
            let key_pem = fs::read_to_string(&key_pem_path)?;
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
            dn.push(DnType::CommonName, "FluxProxy Local Debugging Root CA");
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
            fs::write(&key_pem_path, ca_key.serialize_pem())?;

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
            subject: "CN=FluxProxy Local Debugging Root CA, O=FluxProxy Web Debugger".to_string(),
            valid_until: self.valid_until.clone(),
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
            let output = Command::new("certutil")
                .args(["-user", "-addstore", "Root", &cert_path])
                .output()?;

            if output.status.success() {
                return Ok("Root CA installed into Windows CurrentUser Trusted Root Store.".into());
            }
            return Err(ProxyError::Custom(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        #[cfg(target_os = "macos")]
        {
            let home = std::env::var("HOME").unwrap_or_default();
            let login_keychain = format!("{home}/Library/Keychains/login.keychain-db");
            let output = Command::new("security")
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
            return Err(ProxyError::Custom(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ));
        }

        #[cfg(target_os = "linux")]
        {
            let pem_path = self.cert_pem_path.display().to_string();
            let output = Command::new("pkexec")
                .args([
                    "sh",
                    "-c",
                    &format!(
                        "cp '{}' /usr/local/share/ca-certificates/fluxproxy-root-ca.crt && update-ca-certificates",
                        pem_path
                    ),
                ])
                .output()?;

            if output.status.success() {
                return Ok("Root CA installed via update-ca-certificates.".into());
            }
            return Err(ProxyError::Custom(format!(
                "Automatic install failed ({}). Import '{}' manually into your browser/OS trust store.",
                String::from_utf8_lossy(&output.stderr).trim(),
                pem_path
            )));
        }
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
}
