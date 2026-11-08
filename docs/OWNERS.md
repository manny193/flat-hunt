# Who owns what (so parallel work doesn't collide)
- SDE: src/, web/, migrations/, test/ (except test/fixtures/apify-*), scripts/, package.json
- SRE/DevOps: infra/, .github/, Dockerfile, .dockerignore, wrangler config, docs/DEPLOY.md
- Apify specialist: test/fixtures/apify-*, docs/APIFY.md
- QA: test/e2e/, docs/QA.md (bug fixes go through SDE-owned files with a note in docs/QA.md)
- Chief of staff: README.md, docs/DECISIONS.md
- Architect: CLAUDE.md, docs/ai/, docs/human/, docs/README.md (engineers update docs/ai/ARCHITECTURE.md with their changes; see docs/README.md)
- Chief of staff: docs/TRACKING.md, docs/HANDOFF.md
