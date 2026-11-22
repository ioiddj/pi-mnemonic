# Security policy

## Threat model

`pi-mnemonic` runs inside the Pi process with the same OS permissions as the user. It stores memory in the user's Pi state directory and can write prompt cards, skills, and (with explicit confirmation) global `AGENTS.md`. It executes stored shell techniques through `/bin/sh` with bounded timeout/output.

Treat prompt cards, charter configuration, generated skills, and stored techniques as trusted operator configuration. A malicious prompt or repository can try to influence the agent to create or modify them; operator confirmation gates are intentional.

## Secret handling

This extension does **not** discover PII or guarantee secret removal. Credentials and personal data should be stored by reference in `pi-credentials` and passed to the model as tokens such as `{{secret:NAME}}`. Best-effort redaction is applied to captured command output and technique details, but raw values supplied by an agent can still enter contexts and logs.

## Reporting

Please report vulnerabilities through a private GitHub security advisory on this repository. Include reproduction steps, affected version, and impact. Do not open public issues for undisclosed vulnerabilities.

## Supported versions

Security fixes are applied to the latest published version only.
