# Fixtures

Used when `HARNESS_ENV=fixture`. Fixture runtimes are synthetic: they must never contain live VERTIGO
runtime identifiers (PT-ARCH-002 scans this directory too). Live read-only validations use
`HARNESS_ENV=live_readonly` and resolve everything from `VERTIGO_META_SPEC_ROOT` at run time.
