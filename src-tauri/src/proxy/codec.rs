use std::io::{Read, Write};

use base64::Engine as _;
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;

use crate::models::{CodecOperation, CodecTransformResult, ProxyError};

const MAX_CODEC_DECOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug)]
enum CodecDecompressError {
    LimitExceeded,
    InvalidStream(String),
}

fn read_bounded_codec_output<R: Read>(
    reader: R,
    max_bytes: u64,
    codec_label: &str,
) -> Result<Vec<u8>, CodecDecompressError> {
    let mut out = Vec::new();
    reader
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut out)
        .map_err(|e| CodecDecompressError::InvalidStream(format!("{codec_label} decompression failed: {e}")))?;
    if (out.len() as u64) > max_bytes {
        return Err(CodecDecompressError::LimitExceeded);
    }
    Ok(out)
}

fn map_codec_decompress_error(err: CodecDecompressError, codec_label: &str, max_bytes: u64) -> ProxyError {
    match err {
        CodecDecompressError::LimitExceeded => ProxyError::Custom(format!(
            "{codec_label} decompressed payload exceeds safety limit ({max_bytes} bytes)"
        )),
        CodecDecompressError::InvalidStream(msg) => ProxyError::Custom(msg),
    }
}

/// Executes binary compression / decompression transforms (Gzip, Brotli, Deflate, Zstd)
/// for the built-in TextWizard utility.
///
/// - For `*Compress` operations, `input` is treated as UTF-8 text (unless `input_is_base64 == true`).
/// - For `*Decompress` operations, `input` is decoded from Base64 or Hex bytes automatically.
pub fn execute_codec_transform(
    operation: CodecOperation,
    input: &str,
    input_is_base64: bool,
) -> Result<CodecTransformResult, ProxyError> {
    execute_codec_transform_with_limit(operation, input, input_is_base64, MAX_CODEC_DECOMPRESSED_BYTES)
}

fn execute_codec_transform_with_limit(
    operation: CodecOperation,
    input: &str,
    input_is_base64: bool,
    max_decompressed_bytes: u64,
) -> Result<CodecTransformResult, ProxyError> {
    let raw_bytes = match operation {
        CodecOperation::GzipCompress
        | CodecOperation::BrotliCompress
        | CodecOperation::DeflateCompress
        | CodecOperation::ZstdCompress => {
            if input_is_base64 {
                decode_base64_or_hex(input)?
            } else {
                input.as_bytes().to_vec()
            }
        }
        CodecOperation::GzipDecompress
        | CodecOperation::BrotliDecompress
        | CodecOperation::DeflateDecompress
        | CodecOperation::ZstdDecompress => decode_base64_or_hex(input)?,
    };

    let input_len = raw_bytes.len();
    let out_bytes = match operation {
        CodecOperation::GzipCompress => {
            let mut enc = GzEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&raw_bytes)?;
            enc.finish()?
        }
        CodecOperation::GzipDecompress => read_bounded_codec_output(
            GzDecoder::new(raw_bytes.as_slice()),
            max_decompressed_bytes,
            "Gzip",
        )
        .map_err(|e| map_codec_decompress_error(e, "Gzip", max_decompressed_bytes))?,
        CodecOperation::BrotliCompress => {
            let mut out = Vec::new();
            {
                let mut writer = brotli::CompressorWriter::new(&mut out, 4096, 6, 22);
                writer.write_all(&raw_bytes)?;
                writer.flush()?;
            }
            out
        }
        CodecOperation::BrotliDecompress => read_bounded_codec_output(
            brotli::Decompressor::new(raw_bytes.as_slice(), 4096),
            max_decompressed_bytes,
            "Brotli",
        )
        .map_err(|e| map_codec_decompress_error(e, "Brotli", max_decompressed_bytes))?,
        CodecOperation::DeflateCompress => {
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&raw_bytes)?;
            enc.finish()?
        }
        CodecOperation::DeflateDecompress => {
            // Try RFC 1950 Zlib wrapper first (HTTP `Content-Encoding: deflate`), then raw RFC 1951 deflate
            match read_bounded_codec_output(
                ZlibDecoder::new(raw_bytes.as_slice()),
                max_decompressed_bytes,
                "Deflate",
            ) {
                Ok(out) => out,
                Err(CodecDecompressError::LimitExceeded) => {
                    return Err(map_codec_decompress_error(
                        CodecDecompressError::LimitExceeded,
                        "Deflate",
                        max_decompressed_bytes,
                    ));
                }
                Err(CodecDecompressError::InvalidStream(_)) => read_bounded_codec_output(
                    DeflateDecoder::new(raw_bytes.as_slice()),
                    max_decompressed_bytes,
                    "Deflate",
                )
                .map_err(|e| map_codec_decompress_error(e, "Deflate", max_decompressed_bytes))?,
            }
        }
        CodecOperation::ZstdCompress => zstd::encode_all(raw_bytes.as_slice(), 3)
            .map_err(|e| ProxyError::Custom(format!("Zstd compression failed: {e}")))?,
        CodecOperation::ZstdDecompress => {
            let dec = zstd::stream::read::Decoder::new(raw_bytes.as_slice())
                .map_err(|e| ProxyError::Custom(format!("Zstd decompression failed: {e}")))?;
            read_bounded_codec_output(dec, max_decompressed_bytes, "Zstd")
                .map_err(|e| map_codec_decompress_error(e, "Zstd", max_decompressed_bytes))?
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
        && stripped_hex.len().is_multiple_of(2)
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

    #[test]
    fn roundtrips_zstd() {
        let sample = "{\"service\":\"FluxProxy\",\"codec\":\"Zstandard 🚀\",\"items\":[1,2,3,4,5]}";

        let compressed =
            execute_codec_transform(CodecOperation::ZstdCompress, sample, false).unwrap();
        assert!(!compressed.output_base64.is_empty());
        assert!(!compressed.output_hex.is_empty());
        assert!(compressed.output_hex.starts_with("28b52ffd"));

        let from_b64 = execute_codec_transform(
            CodecOperation::ZstdDecompress,
            &compressed.output_base64,
            true,
        )
        .unwrap();
        assert_eq!(from_b64.output_text.as_deref(), Some(sample));

        let from_hex = execute_codec_transform(
            CodecOperation::ZstdDecompress,
            &compressed.output_hex,
            true,
        )
        .unwrap();
        assert_eq!(from_hex.output_text.as_deref(), Some(sample));
    }

    #[test]
    fn sec05_zstd_codec_rejects_decompressed_output_exceeding_limit() {
        let large_text = "B".repeat(4096);
        let compressed =
            execute_codec_transform(CodecOperation::ZstdCompress, &large_text, false).unwrap();
        let err = execute_codec_transform_with_limit(
            CodecOperation::ZstdDecompress,
            &compressed.output_base64,
            true,
            1024,
        )
        .expect_err("must reject oversized zstd decompression output");
        assert!(err.to_string().contains("exceeds safety limit"));
    }
}
