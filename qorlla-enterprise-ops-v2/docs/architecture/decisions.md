# Architecture decisions

1. Qorlla identity is the sole authentication authority; no parallel password database.
2. Numbers & Plans is sole number authority; adapters are read-only until approved contracts.
3. External call purchase requests cannot enable PSTN, allocate numbers or charge customers.
4. Separate service boundaries; no shared mutable domain tables between external systems.
5. Staff queries are tenant-filtered, and agents only see assigned tickets in the starter.
6. Existing Qorlla repo and service contracts must be reviewed before production merge.
