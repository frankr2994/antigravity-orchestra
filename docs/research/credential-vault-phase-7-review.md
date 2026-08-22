# Credential vault and key-management research

Research date: 2026-08-22

## Overview

Commit `d28b30f` uses sound authenticated-encryption primitives, but its encryption key is reproducible from public machine metadata and therefore does not satisfy the plan's OS-protected credential-store requirement. Its persistence and validation paths also need fail-closed recovery and redacted, structured errors.

## Research purpose

Assess whether the Phase 7 commit securely stores Jules credentials on the project's primary Windows platform and whether its storage, validation, and failure behavior follows authoritative guidance.

## Findings

### OS-protected storage

Microsoft documents that Windows DPAPI `CryptProtectData` normally ties decryption to the same user's logon credentials and machine. This supplies a protection boundary that hostname, username, and profile-path strings do not. The reviewed vault does not use DPAPI or another OS credential facility.

OWASP recommends using secure storage supplied by the operating system, framework, cloud provider, or a dedicated secret manager where available. It also recommends separating encryption keys from encrypted data and supporting key lifecycle operations.

### Cryptographic construction

AES-256-GCM with a random 12-byte IV and authentication tag is an appropriate authenticated-encryption construction. Node's documentation emphasizes unique, unpredictable IVs and confirms that authentication failure must cause ciphertext to be discarded.

The weakness is key management: deriving the key from hostname, username, and profile path with a constant salt makes it reproducible. A local probe reconstructed the key from those inputs and decrypted the test value independently.

### File permissions and durability

Node documents that `mode` affects a file only when it is created and that Windows can manipulate only write permission rather than POSIX owner/group/other distinctions. Therefore `mode: 0o600` is not an owner-only Windows ACL and does not correct an existing file's permissions.

Writing directly over the live file without a temporary file, flush, atomic replace, backup, or writer serialization creates a credential-loss risk. Treating every load failure as an empty vault compounds that risk because the next save can overwrite recoverable ciphertext.

### Validation and error handling

Credential validation must distinguish invalid credentials from authorization failures, rate limits, outages, and malformed provider responses. Client responses should use fixed, non-secret messages; upstream details should remain in redacted correlated diagnostics only.

## Evaluation

| Area | Assessment | Notes |
|------|------------|-------|
| Cipher and IV | Good primitive choice | AES-256-GCM and random 12-byte IV |
| Encryption-key protection | Unsafe | Reproducible public metadata; no OS protection |
| Windows file access control | Insufficient | POSIX mode does not provide owner-only Windows ACLs |
| Write durability | Insufficient | Direct overwrite and no recovery transaction |
| Corruption handling | Unsafe | Failures become an empty vault and may be overwritten |
| Credential validation | Insufficient | Malformed success accepted; failure classes flattened |
| Error redaction | Unsafe | Arbitrary submitted keys can be reflected |

## Conclusion

Replace the custom metadata-derived vault with platform credential-store adapters, beginning with current-user Windows DPAPI for this workspace. Keep an encrypted-file fallback only if it has a genuinely protected key, verified ACLs, atomic/versioned persistence, explicit recovery, and fail-closed errors. Expose credential validation through typed status codes and safe fixed messages, and test the complete authenticated HTTP boundary.

## References

- https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- https://nodejs.org/api/fs.html
- https://nodejs.org/api/crypto.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- https://csrc.nist.gov/pubs/sp/800/57/pt1/r5/final

## Related repair items

See R-043 through R-049 in `repair.md`.
