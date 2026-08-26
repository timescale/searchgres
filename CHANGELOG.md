# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-release development. Nothing published yet.

### Added

- Project scaffolding: license, notice, readme, npm workspace, TypeScript 7
  build, runtime-portability lint rules, and cross-runtime package smoke tests.
- Initial public core primitives: typed errors and Zod-backed schema, ltree, and
  index-creation validation with inferred TypeScript types, structured
  validation issues, and pgvector, pg_textsearch, and HNSW defaults and bounds.
- Database plumbing: PostgreSQL 18 preflight, serialized extension installation
  and schema discovery, transaction-local migration timeouts, SQL spans, typed
  timeout/extension failures, Docker-backed integration tests, and CI coverage.
- Immutable schema provisioning: one atomic `createIndex` flow, singleton format
  marker, record and queue schemas, configured search indexes, and
  integrity/enqueue triggers that protect asynchronous embedding for direct SQL
  writers. Existing schemas are rebuilt rather than migrated in place.
- Core builds clean emitted artifacts first, preventing deleted source modules
  from remaining in published tarballs.
