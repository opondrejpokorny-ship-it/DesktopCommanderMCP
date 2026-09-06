DC2 local-preservation bundle — 2026-09-06
Contains exact Git objects that could not be pushed as branch tips because the current OAuth token lacks workflow scope.
Included local refs/commits:
3c61fefa5b8f6ec18cab56a3ffaa531b36949fdc — active-work enforcement test hardening
7ae54f441f972af5e98afb953569d7085fc07d97 — Commercial Contract v1 pre-PR commit
1a96df57efceaef4b94779b0a7c40fd534636195 — remote recovery CI gate
Restore with git bundle verify / git fetch <bundle> <ref>. This branch is preservation evidence only; do not merge it into prototype.
