use std::io::{Read, Write};

use base64::Engine as _;
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;

use crate::models::{CodecOperation, CodecTransformResult, ProxyError};

/// Executes binary compression / decompression transforms (Gzip, Brotli, Deflate)
/// for the built-in TextWizard utility.
///
/// - For `*Compress` operations, `input` is treated as UTF-8 text (unless `input_is_base64 == true`).
/// - For `*Decompress` operations, `input` is decoded from Base64 or Hex bytes automatically.
pub fn execute_codec_transform(
    operation: CodecOperation,
    input: &str,
    input_is_base64: bool,
) -> Result<CodecTransformResult, ProxyError> {
    let raw_bytes = match operation {
        CodecOperation::GzipCompress
        | CodecOperation::BrotliCompress
        | CodecOperation::DeflateCompress => {
            if input_is_base64 {
                decode_base64_or_hex(input)?
            } else {
                input.as_bytes().to_vec()
            }
        }
        CodecOperation::GzipDecompress
        | CodecOperation::BrotliDecompress
        | CodecOperation::DeflateDecompress => decode_base64_or_hex(input)?,
    };

    let input_len = raw_bytes.len();
    let out_bytes = match operation {
        CodecOperation::GzipCompress => {
            let mut enc = GzEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&raw_bytes)?;
            enc.finish()?
        }
        CodecOperation::GzipDecompress => {
            let mut dec = GzDecoder::new(raw_bytes.as_slice());
            let mut out = Vec::new();
            dec.read_to_end(&mut out)
                .map_err(|e| ProxyError::Custom(format!("Gzip decompression failed: {e}")))?;
            out
        }
        CodecOperation::BrotliCompress => {
            let mut out = Vec::new();
            {
                let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 6, 22);
                writer.write_all(&raw_bytes)?;
                writer.flush()?;
            }
            out
        }
        CodecOperation::BrotliDecompress => {
            let mut dec = brotli::Decompressor::new(raw_bytes.as_slice(), 4096);
            let mut out = Vec::new();
            dec.read_to_end(&mut out)
                .map_err(|e| ProxyError::Custom(format!("Brotli decompression failed: {e}")))?;
            out
        }
        CodecOperation::DeflateCompress => {
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&raw_bytes)?;
            enc.finish()?
        }
        CodecOperation::DeflateDecompress => {
            // Try RFC 1950 Zlib wrapper first (HTTP `Content-Encoding: deflate`), then raw RFC 1951 deflate
            let mut out = Vec::new();
            if ZlibDecoder::new(raw_bytes.as_slice())
                .read_to_end(&mut out)
                .is_err()
            {
                out.clear();
                DeflateDecoder::new(raw_bytes.as_slice())
                    .read_to_end(&mut out)
                    .map_err(|e| {
                        ProxyError::Custom(format!("Deflate decompression failed: {e}"))
                    })?;
            }
            out
        }
    };

    let output_len = out_bytes.len();
    let output_base64 = base64::engine::general_purpose::STANDARD.encode(&out_bytes);
    let output_hex = hex::encode(&out_bytes);
    let output_text = std::str::from_utf8(&out_bytes).ok().map(str::to_owned);

    Ok(CodecTransformResult {
        output_base64,
        output_text,
        output_hex,
        input_bytes: input_len,
        output_bytes: output_len,
    })
}

fn decode_base64_or_hex(raw: &str) -> Result<Vec<u8>, ProxyError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Check if clean hex string (even length, all hex chars after stripping spaces/colons/0x)
    let stripped_hex: String = trimmed
        .trim_start_matches("0x")
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    if stripped_hex.len() >= 4
        && stripped_hex.len() % 2 == 0
        && stripped_hex.chars().all(|c| c.is_ascii_hexdigit())
        && !trimmed.contains('=')
        && !trimmed.contains('+')
        && !trimmed.contains('/')
    {
        if let Ok(bytes) = hex::decode(&stripped_hex) {
            return Ok(bytes);
        }
    }

    let cleaned_b64: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(&cleaned_b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cleaned_b64.trim_end_matches('=')))
        .map_err(|e| {
            ProxyError::Custom(format!(
                "Expected Base64 or Hex encoded compressed bytes: {e}"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_gzip_brotli_and_deflate() {
        let sample = "{\"service\":\"FluxProxy\",\"feature\":\"TextWizard Compression Test 🚀\"}";

        for (enc_op, dec_op) in [
            (CodecOperation::GzipCompress, CodecOperation::GzipDecompress),
            (
                CodecOperation::BrotliCompress,
                CodecOperation::BrotliDecompress,
            ),
            (
                CodecOperation::DeflateCompress,
                CodecOperation::DeflateDecompress,
            ),
        ] {
            let compressed = execute_codec_transform(enc_op, sample, false).unwrap();
            assert!(!compressed.output_base64.is_empty());

            let decompressed =
                execute_codec_transform(dec_op, &compressed.output_base64, true).unwrap();
            assert_eq!(decompressed.output_text.as_deref(), Some(sample));
        }
    }
}
