<!-- From AIVA OSHealth, adapted to the merged application. -->
# Attached documents and where they are stored

Consent forms, outside reports and scans can be attached to a visit or admission (`/api/v1/ipd/:encounterId/documents`). The files are health records, so where they are kept matters.

## Rules the server enforces

- PDF, PNG, JPEG or WEBP only, up to 10 MB. The type is decided from the file's first bytes, not from its name or what the sender says it is, and the saved name's extension follows the content.
- Each hospital's files are stored under its own prefix (`<hospital id>/<visit id>/<document id>`); a document is found through the hospital's own records, so another hospital cannot reach it.
- Viewing is audited ("Document Viewed"); adding and removing are audited too. A document is never deleted: it is marked removed, with a reason and who did it; the file stays for the audit trail. Administrators can still see removed ones.
- Who: attach and view: nurse, doctor, front office, biller, admin. Remove: doctor, admin.
- Files are served with `Cache-Control: private, no-store`.

## Where files are kept (`FILE_STORE`)

| Value | Meaning |
|---|---|
| `local` | A folder on the server's disk (`FILE_STORE_DIR`, default `./data/files`). The default on a development computer. Fine for a server with a persistent disk; **not** on a hosting plan whose disk is wiped on deploy. |
| `memory` | Lost when the process stops. Tests only. |
| `none` | Nothing configured: attaching a document is refused with a clear message (HTTP 503, `STORAGE_NOT_CONFIGURED`). **The default in production**, so documents are never silently lost. |

## Moving to storage in India

Real patient documents belong in an object store in an Indian region (for example Mumbai or Hyderabad), encrypted at rest, with versioning or backups. The app only talks to the `FileStore` interface in `backend/src/hospital/modules/storage/file-store.ts` (`put(key, data)` and `get(key)`), so this is one more class and one setting:

1. Create the bucket in the Indian region and a key limited to that bucket.
2. Add an `S3FileStore` (any S3-compatible service: AWS S3 in `ap-south-1`, an Indian provider's object storage, and so on) implementing `put` and `get`, and a `FILE_STORE=s3` option with the endpoint, bucket and region in the environment.
3. Keep the same key layout, so nothing already stored needs to move.

This is not built yet because it needs the bucket and its credentials, which the owner provides. Until then use `local` on a machine with a persistent disk, or leave it at `none`.
