use std::fs;
use std::path::Path;

/// Prefix marking a private key file protected with Windows DPAPI (`CryptProtectData`).
pub const DPAPI_PREFIX: &str = "FLUX_DPAPI_V1:";

#[cfg(target_os = "windows")]
mod win32 {
    use std::ptr;

    use base64::Engine as _;
    use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    use super::DPAPI_PREFIX;

    struct LocalAllocBlobGuard {
        pb: *mut u8,
        cb: usize,
        wipe_on_drop: bool,
    }

    impl Drop for LocalAllocBlobGuard {
        fn drop(&mut self) {
            if !self.pb.is_null() {
                unsafe {
                    if self.wipe_on_drop && self.cb > 0 {
                        ptr::write_bytes(self.pb, 0, self.cb);
                    }
                    LocalFree(self.pb as HLOCAL);
                }
            }
        }
    }

    pub fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, std::io::Error> {
        let cb_in = u32::try_from(plain.len()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Key material exceeds Win32 DPAPI u32 size limit",
            )
        })?;
        let data_in = CRYPT_INTEGER_BLOB {
            cbData: cb_in,
            pbData: if plain.is_empty() {
                ptr::null_mut()
            } else {
                plain.as_ptr() as *mut u8
            },
        };
        let mut data_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        let ok = unsafe {
            CryptProtectData(
                &data_in,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }

        let guard = LocalAllocBlobGuard {
            pb: data_out.pbData,
            cb: data_out.cbData as usize,
            wipe_on_drop: false,
        };
        let cipher = if guard.pb.is_null() || guard.cb == 0 {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(guard.pb, guard.cb) }
        };

        let b64 = base64::engine::general_purpose::STANDARD.encode(cipher);
        let mut encoded = Vec::with_capacity(DPAPI_PREFIX.len() + b64.len());
        encoded.extend_from_slice(DPAPI_PREFIX.as_bytes());
        encoded.extend_from_slice(b64.as_bytes());
        Ok(encoded)
    }

    pub fn unprotect_bytes(encoded: &[u8]) -> Result<Vec<u8>, std::io::Error> {
        let text = std::str::from_utf8(encoded).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Invalid UTF-8 in DPAPI key payload: {e}"),
            )
        })?;
        let b64_part = text
            .strip_prefix(DPAPI_PREFIX)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Missing FLUX_DPAPI_V1: prefix",
                )
            })?
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect::<String>();

        let cipher = base64::engine::general_purpose::STANDARD
            .decode(b64_part)
            .map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Invalid base64 in DPAPI key payload: {e}"),
                )
            })?;

        let cb_in = u32::try_from(cipher.len()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "DPAPI ciphertext exceeds Win32 u32 size limit",
            )
        })?;
        let data_in = CRYPT_INTEGER_BLOB {
            cbData: cb_in,
            pbData: if cipher.is_empty() {
                ptr::null_mut()
            } else {
                cipher.as_ptr() as *mut u8
            },
        };
        let mut data_out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };

        let ok = unsafe {
            CryptUnprotectData(
                &data_in,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }

        let guard = LocalAllocBlobGuard {
            pb: data_out.pbData,
            cb: data_out.cbData as usize,
            wipe_on_drop: true,
        };
        let plain = if guard.pb.is_null() || guard.cb == 0 {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(guard.pb, guard.cb) }.to_vec()
        };
        Ok(plain)
    }
}

fn trim_leading_bom_and_ws(mut bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes = &bytes[3..];
    }
    while let Some((&first, rest)) = bytes.split_first() {
        if first.is_ascii_whitespace() {
            bytes = rest;
        } else {
            break;
        }
    }
    bytes
}

/// Writes private key material securely to `path`:
/// - On Windows: encrypts via Win32 DPAPI (`CryptProtectData` + `CRYPTPROTECT_UI_FORBIDDEN`) with `FLUX_DPAPI_V1:<base64>`.
/// - On Unix: writes raw bytes with `0600` file permissions.
pub fn write_protected_key_bytes(path: &Path, plain_bytes: &[u8]) -> Result<(), std::io::Error> {
    #[cfg(target_os = "windows")]
    {
        let protected = win32::protect_bytes(plain_bytes)?;
        fs::write(path, protected)
    }

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
        file.write_all(plain_bytes)?;
        file.sync_all()?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "windows", unix)))]
    {
        fs::write(path, plain_bytes)
    }
}

/// Reads private key material from `path`.
/// Transparently decrypts `FLUX_DPAPI_V1:<base64>` payloads on Windows and migrates
/// legacy plaintext `-----BEGIN` PEM key files into DPAPI on first load.
pub fn read_protected_key_bytes(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    let raw = fs::read(path)?;
    let trimmed = trim_leading_bom_and_ws(&raw);

    if trimmed.starts_with(DPAPI_PREFIX.as_bytes()) {
        #[cfg(target_os = "windows")]
        {
            win32::unprotect_bytes(trimmed)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Cannot decrypt Windows DPAPI key payload (FLUX_DPAPI_V1:) on this OS",
            ))
        }
    } else if trimmed.starts_with(b"-----BEGIN") {
        #[cfg(target_os = "windows")]
        {
            if let Err(err) = write_protected_key_bytes(path, &raw) {
                tracing::warn!(
                    "Failed to migrate plain PEM key '{}' to Windows DPAPI: {err}",
                    path.display()
                );
            }
        }
        Ok(raw)
    } else {
        Ok(raw)
    }
}

/// Reads UTF-8 private key text from `path`, transparently handling DPAPI decryption and legacy PEM migration.
pub fn read_protected_key_string(path: &Path) -> Result<String, std::io::Error> {
    let bytes = read_protected_key_bytes(path)?;
    String::from_utf8(bytes).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Private key '{}' is not valid UTF-8: {e}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_roundtrip_and_plain_pem_migration_on_windows() {
        let dir = std::env::temp_dir().join(format!(
            "fluxproxy_dpapi_unit_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let key_path = dir.join("test.key");
        let sample_pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCtest\n-----END PRIVATE KEY-----\n";

        // 1. Writing encrypts with FLUX_DPAPI_V1: prefix and hides PEM header
        write_protected_key_bytes(&key_path, sample_pem.as_bytes()).unwrap();
        let disk_text = fs::read_to_string(&key_path).unwrap();
        assert!(disk_text.starts_with(DPAPI_PREFIX));
        assert!(!disk_text.contains("-----BEGIN"));

        // 2. Reading decrypts transparently back to exact original bytes
        let loaded = read_protected_key_string(&key_path).unwrap();
        assert_eq!(loaded, sample_pem);

        // 3. Legacy plaintext PEM file is read cleanly and migrated in-place to DPAPI
        fs::write(&key_path, sample_pem.as_bytes()).unwrap();
        assert!(fs::read_to_string(&key_path).unwrap().starts_with("-----BEGIN"));
        let migrated_loaded = read_protected_key_string(&key_path).unwrap();
        assert_eq!(migrated_loaded, sample_pem);
        let migrated_disk = fs::read_to_string(&key_path).unwrap();
        assert!(migrated_disk.starts_with(DPAPI_PREFIX));
        assert!(!migrated_disk.contains("-----BEGIN"));

        let _ = fs::remove_dir_all(&dir);
    }
}
