# Contributing Guide

Welcome to the project.

The repository is currently in its **initial development phase**, so foundational decisions around architecture, database design, module boundaries, security, and development patterns are especially important.

The goal is not just to make features work, but to establish a codebase that remains maintainable as the HMS and ABDM integrations grow.

---

## Repository Structure

The project is organized as separate application areas:

```text
/
├── frontend/
│
└── backend/
```

This document primarily covers contribution guidelines for the **backend**.

---

# Backend

The backend is a TypeScript-based API application.

Before adding a feature, understand the existing architecture and determine where the feature belongs rather than placing implementation wherever is most convenient.

---

## 1. Database & Prisma

Prisma is used as the ORM and database schema management tool.

The Prisma schema lives under:

```text
/backend/prisma/
```

### Migrations

**Prisma migrations are the source of truth for database schema changes.**

When modifying the database schema:

```bash
npx prisma migrate dev --name <migration-name>
```

Commit the resulting migration along with your schema changes.

### Do not

Avoid making schema changes directly in the database without creating a corresponding Prisma migration.

Avoid using:

```bash
npx prisma db push
```

as the normal workflow for committed schema changes.

If a database change is necessary, the expected workflow is:

```text
Modify schema.prisma
        ↓
Create Prisma migration
        ↓
Test migration locally
        ↓
Commit schema + migration
```

### Before changing the schema

Check existing models and relationships first.

A seemingly small database change can affect:

* API contracts
* services
* authentication
* authorization
* ABDM integrations
* existing migrations
* future data relationships

Database changes should therefore be treated as architectural changes, not just implementation details.

---

# 2. ABDM / ABHA Integrations

ABDM integrations are intentionally isolated from the core application.

The integration layer will live under:

```text
/backend/src/integrations/
```

Expected structure:

```text
src/
└── integrations/
    └── abdm/
        ├── m1/
        ├── m2/
        └── m3/
```

The ABDM modules will contain the implementation for:

* **M1** — ABHA identity and care-context integration
* **M2** — ABDM/FHIR record-sharing functionality
* **M3** — consent-driven data exchange

### Important

Do not scatter ABDM-specific API calls throughout controllers and services.

For example, avoid:

```text
controller
    ↓
ABDM API call
```

Prefer:

```text
controller
    ↓
service
    ↓
ABDM integration
    ↓
ABDM API
```

This keeps the core HMS independent from the ABDM implementation and makes future changes to the ABDM APIs easier to manage.

---

# 3. Git Workflow

Create a branch for your work.

Example:

```bash
git checkout -b feature/patient-registration
```

or:

```bash
git checkout -b fix/auth-error-handling
```

Keep commits focused.

Good:

```text
feat: add patient registration
fix: handle duplicate patient email
refactor: separate ABHA integration service
```

Avoid mixing unrelated changes into one commit.

---

# 4. Architecture Matters

This codebase is in its **initial phase**.

That means foundational and architectural changes have a much larger impact than they would in a mature codebase.

Before implementing something, consider:

* Where does this responsibility belong?
* Is this logic reusable?
* Does this create unnecessary coupling?
* Does this belong in the core HMS or an integration?
* Will this design work when more facilities/features are added?
* Does this introduce unnecessary duplication?
* Is the database relationship correct?
* Does this affect authentication or authorization?

### Do not optimize only for "making the current feature work."

A solution that works today but creates significant technical debt should be discussed before being merged.

---

# 5. Architectural Changes

Because the project is still young, **architectural improvements are encouraged**.

If you believe an existing approach should change, raise it rather than working around it silently.

Examples of changes worth discussing:

* Database relationship changes
* Authentication architecture
* Authorization model
* Module boundaries
* Folder structure
* API conventions
* ABDM integration boundaries
* Error handling
* Validation strategy
* Configuration/secrets management
* Multi-facility support
* Major dependency changes

Small implementation decisions do not require a discussion every time.

However, if a change affects the **foundation of the application**, discuss it with the team before committing to the approach.

---

# 6. Keep Responsibilities Separate

Try to maintain clear boundaries between:

```text
Routes
   ↓
Controllers
   ↓
Services
   ↓
Data / Prisma
```

And for external integrations:

```text
Services
   ↓
Integration layer
   ↓
External API
```

Avoid putting large amounts of business logic directly inside routes or controllers.

Controllers should primarily handle things such as:

* Request parsing
* Calling the appropriate service
* Returning the response

Business logic should generally live in services or appropriate domain modules.

---

# 7. Validation & Errors

Validate external input before it reaches business logic.

Use the project's established validation approach consistently.

For application errors, use the existing `ApiError` / centralized error-handling mechanism rather than manually constructing inconsistent error responses throughout the codebase.

Example:

```ts
throw new ApiError(404, "Patient not found");
```

The centralized error middleware should be responsible for converting application errors into HTTP responses.

---

# 8. Secrets & Environment Variables

Never commit secrets to Git.

This includes:

* Database credentials
* JWT secrets
* ABDM credentials
* API keys
* OAuth secrets
* Private keys
* Production credentials

Use environment variables / the project's configured secrets mechanism.

Never hard-code credentials inside source files.

---

# 9. Pull Requests

Before opening a PR:

```bash
npm run lint
npm test
npm run build
```

Use the project's actual scripts if these commands differ.

A PR should ideally explain:

### What changed?

Briefly describe the implementation.

### Why?

Explain the problem or requirement being addressed.

### Architectural impact

Mention if the change affects:

* Database schema
* API contracts
* Authentication
* Authorization
* ABDM integrations
* Existing modules
* Infrastructure

### Database changes

If Prisma migrations were added, explicitly mention them in the PR.

---

# 10. Before You Code

For larger features, take a few minutes to understand the existing system first.

At minimum, inspect:

```text
Routes
Services
Database schema
Existing migrations
Authentication
Error handling
Related integrations
```

Then decide where your implementation belongs.

Do not assume that the first place you find is necessarily the correct place to add the feature.

---

# 11. General Principle

The project is early enough that **we are still building the foundation**.

Therefore:

> **Don't be afraid to change the architecture when there is a good reason. But don't introduce architectural changes casually either.**

Prioritize:

```text
Correctness
    ↓
Clear architecture
    ↓
Maintainability
    ↓
Security
    ↓
Scalability
    ↓
Feature implementation
```

The goal is to build a backend that can continue evolving as the HMS and ABDM integrations become more complex.
