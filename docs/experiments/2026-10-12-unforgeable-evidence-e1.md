# Experiment: Windows Hello security key (E-1) and the Bitwarden SSH agent (A-6) from WSL (unforgeable-evidence) — 2026-10-12

The unforgeable-evidence spec does not start enforcement until one key custody tier works on the maintainer's WSL host (`docs/specs/unforgeable-evidence/spec/6-implementation-plan.md`, PR-3 entry condition, OPS-4). Experiment E-1 asks if Windows OpenSSH (`ssh-keygen.exe`), started from WSL, can hold an OpenSSH security-key (`sk-`) key in Windows Hello. This record has the unattended probes, the three attended E-1 attempts, and the WebAuthN log lines. It also has the attended A-6 run with the Bitwarden desktop SSH agent, which measured the spec's A-6 tier (§8 A-6).

## Question (from the spec, written before the run)

> Sign with Windows OpenSSH (`ssh-keygen.exe`) through Windows Hello from inside WSL, verify the signature with Linux `ssh-keygen`, and record whether a WSL process can complete the Windows Hello prompt without the human. Also record whether a USB security key that `usbipd-win` attaches to WSL2 signs with the user-presence flag. The result decides which tier WSL users get.

The spec locked no numeric decision rule. A key must exist before it can sign, so each attempt starts with an enrollment (WebAuthn `MakeCredential`).

## Environment

- **Machine:** the maintainer's Windows host, WSL2 (kernel 6.6.87.2), with WSL interop on (spec §8 A-4).
- **OpenSSH:**

| Side    | Version                                     | Location                          | `sk-` key types in `ssh -Q key` |
| ------- | ------------------------------------------- | --------------------------------- | ------------------------------- |
| Linux   | `OpenSSH_9.6p1 Ubuntu-3ubuntu13.19`         | `/usr/bin`                        | 4                               |
| Windows | `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2` | `/mnt/c/Windows/System32/OpenSSH` | 4                               |

- **FIDO tooling in WSL:** no `fido2-token`, no `ykman`, no `lsusb`, and no `/dev/hidraw*`.
- **USB passthrough:** `usbipd-win` is absent on Windows.
- **Hardware key:** none on the host.

## Method

1. Unattended, read-only probes: the versions and the key types above.
2. Attended attempts, with the owner present. Each one runs this command from WSL, with a different key type or route:

   ```bash
   /mnt/c/Windows/System32/OpenSSH/ssh-keygen.exe -t <ed25519-sk|ecdsa-sk> -N "" -f 'C:\Users\<user>\.ssh\dotbabel-e1-test'
   ```

3. After the attempts, read the `Microsoft-Windows-WebAuthN/Operational` event log for the time window of each attempt.

## Attended attempts

| #   | Start (UTC) | Key type     | Route               | Windows dialog                            | Key file |
| --- | ----------- | ------------ | ------------------- | ----------------------------------------- | -------- |
| 1   | 22:21:17    | `ed25519-sk` | default             | "There was a problem saving your passkey" | none     |
| 2   | 22:24:53    | `ecdsa-sk`   | default             | the same                                  | none     |
| 3   | 22:32:48    | `ecdsa-sk`   | phone, Bluetooth on | the same                                  | none     |

Two sources disagree on the end of attempt 1. The attended note records a timeout at 180 s. The log records `0x800704C7` "The operation was canceled by the user" at 22:23:12, about 115 s after the start at 22:21:17. A timeout does not give a user-cancel code, so this record takes the logged cancel as the end of attempt 1, and keeps the 180 s note only as the note. Attempts 2 and 3 end the same way in the log, at 22:25:26 and 22:33:19.

Counts: 3 attempts, 2 key types, 3 Windows Hello refusals, 4 phone tunnels, 4 tunnel failures, 0 key files.

## Log lines (`Microsoft-Windows-WebAuthN/Operational`)

Every attempt logs the same sequence. These are the lines of attempt 1, with the event ID:

```text
22:21:17 1101 Cbor encode MakeCredential request. RpId: ssh:
22:21:17 2106 Ctap Name: ImageName Value: C:\Windows\System32\OpenSSH\ssh-sk-helper.exe
22:21:24 1022 WebAuthN Ngc MakeCredential completed. Error: 0x80090029. The requested operation is not supported.
22:22:25 2335 Ctap Hybrid Protocol setup completed. SetupType: QR
22:22:26 2103 Ctap MakeCredential completed. Error: 0x800704CD. An operation was attempted on a nonexistent network connection.
```

The Windows Hello (Ngc) refusal, at event 1022, in each attempt:

| #   | Ngc started | Ngc completed | Error        |
| --- | ----------- | ------------- | ------------ |
| 1   | 22:21:24    | 22:21:24      | `0x80090029` |
| 2   | 22:24:58    | 22:25:02      | `0x80090029` |
| 3   | 22:32:52    | 22:32:57      | `0x80090029` |

The phone (hybrid) tunnels. In each one, Windows reads one message from the phone, writes the `MakeCredential` request, and the tunnel fails in that same second:

| #   | Attempt | Setup completed (`SetupType: QR`) | Failure (`0x800704CD`) | Seconds after setup |
| --- | ------- | --------------------------------- | ---------------------- | ------------------- |
| 1   | 1       | 22:22:25                          | 22:22:26               | 1                   |
| 2   | 1       | 22:22:42                          | 22:22:46               | 4                   |
| 3   | 2       | 22:25:14                          | 22:25:15               | 1                   |
| 4   | 3       | 22:33:12                          | 22:33:13               | 1                   |

## Findings

1. **Windows Hello refuses the request.** In all 3 attempts, Windows Hello (Ngc) `MakeCredential` returns `0x80090029` for the request from `ssh-sk-helper.exe`. The key type is not the cause: `ed25519-sk` and `ecdsa-sk` give the same result.
2. **The phone fallback fails too.** Windows then offers the phone (hybrid, QR) flow. In all 4 tunnels, the tunnel fails with `0x800704CD` in the same second as the `MakeCredential` request, 1 to 4 s after setup.
3. **Inference, not proven.** The request carries the relying-party ID `ssh:` (event 1101). Phone passkey providers possibly refuse it, because it is not a web domain. The log does not show the reason on the phone side.
4. **Not reached.** No key was made, so no signature exists. The Linux verify of a Windows signature (spec R-4) did not run. The question whether a WSL process can complete the prompt has no answer.
5. **Not tested.** A USB key through `usbipd-win` (absent), and a USB FIDO2 key through `ssh-keygen.exe` and Windows WebAuthn (no key on the host).
6. **E-2 did not run.** It needs a real authenticator.

## Decision

- **Q-3 is decided: no.** Windows Hello cannot hold an OpenSSH `sk-` key from WSL on this host.
- **Tiers left on this host after E-1, all untested at that time:** a USB FIDO2 key through `ssh-keygen.exe` (spec A-5, with the user-presence flag), the Bitwarden desktop SSH agent (spec A-6, with no user-presence flag), and the separate-user signer (spec A-4, weak while interop is on).
- **Owner decision, 2026-10-12, before the A-6 run:** the Bitwarden desktop SSH agent. The spec records it as KD-13 and §8 A-6. The A-6 run below then measured it. In the spec's predicates, facts (a) and (c) pass, (b) and (d) fail, and (e) is untested (spec §8 A-6).
- **Owner decisions, 2026-10-12, after the A-6 run:** A-6 is accepted as a casual-only tier below the spec's §1 goal, and no FIDO or USB security key is planned on this host. The owner prefers that a generic open-source tool require no hardware key and no password manager, so the spec is parked: dotbabel does not implement signed evidence (spec §6 Status, §8 A-6).

## Attended A-6 run: Bitwarden SSH agent (2026-10-12)

Setup: Bitwarden desktop 2026.9.1 (per-user install), SSH agent on, authorization "Always", Windows `ssh-agent` service disabled, a dedicated Bitwarden-generated Ed25519 key `dotbabel-evidence`. All requests ran from WSL through `ssh-keygen.exe -Y sign -n dotbabel-evidence@v1 -f <public key file>`.

| Request            | Owner action                | Result                                   |
| ------------------ | --------------------------- | ---------------------------------------- |
| `ssh-add.exe -L`   | none                        | listed the public key at once, no dialog |
| sign 1 (22:58:05Z) | approved                    | signature in 2 s                         |
| sign 2 (5 s later) | dialog shown, not answered  | refused after 61 s                       |
| sign 3             | dialog not answered         | refused after 61 s                       |
| sign 4 (23:05:34Z) | dialog not answered in time | refused after 61 s                       |
| sign 5             | dialog not answered in time | refused after 62 s                       |

- The owner did not answer the dialogs of requests 2 to 5. The owner's observation is that these dialogs were missed. This record has no other cause for the refusals.
- The dialog text: "Confirm SSH key usage: `ssh-keygen.exe` is requesting access to `dotbabel-evidence` in order to sign a message" (Authorize, Deny). It is a modal inside the Bitwarden window.
- Signature 1 verified on Linux (OpenSSH 9.6p1) against `namespaces="dotbabel-evidence@v1"`, and failed under the namespace `git`.
- Writable from WSL: `%APPDATA%\Bitwarden\data.json`, `%LOCALAPPDATA%\Programs\Bitwarden\Bitwarden.exe`, `resources\app.asar`. The SSH-agent settings were not found in plain text.
- Not measured: an explicit Deny click.

## Reproduce

```bash
# Unattended probes, from WSL
ssh -V; ssh -Q key | grep -c '^sk-'
W=/mnt/c/Windows/System32/OpenSSH
"$W/ssh.exe" -V; "$W/ssh.exe" -Q key | tr -d '\r' | grep -c '^sk-'
command -v fido2-token ykman lsusb; ls /dev/hidraw*

# Attended (the owner is present): a Windows dialog opens
"$W/ssh-keygen.exe" -t ecdsa-sk -N "" -f 'C:\Users\<user>\.ssh\dotbabel-e1-test'

# The log, for a window around the attempt
powershell.exe -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WebAuthN/Operational'; StartTime=(Get-Date).AddMinutes(-15)} | Sort-Object TimeCreated | Format-List TimeCreated, Id, Message"
```

The A-6 run. Bitwarden desktop is unlocked, its SSH agent is on with authorization "Always", the Windows `ssh-agent` service is disabled, and the vault holds the Ed25519 key `dotbabel-evidence`. The owner answers each dialog. `<user>` is the Windows user name.

```bash
# No dialog: list the public key, and save it on both sides
"$W/ssh-add.exe" -L | tr -d '\r' | tee dotbabel-evidence.pub
cp dotbabel-evidence.pub '/mnt/c/Users/<user>/.ssh/dotbabel-evidence.pub'

# Attended: a Bitwarden dialog opens for each request
printf 'dotbabel A-6 test\n' > msg.txt
"$W/ssh-keygen.exe" -Y sign -n dotbabel-evidence@v1 -f 'C:\Users\<user>\.ssh\dotbabel-evidence.pub' < msg.txt | tr -d '\r' > msg.sig

# Linux OpenSSH: verify against a namespace-pinned signers line
printf 'dotbabel-evidence namespaces="dotbabel-evidence@v1" %s\n' "$(cut -d' ' -f1,2 dotbabel-evidence.pub)" > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I dotbabel-evidence -n dotbabel-evidence@v1 -s msg.sig < msg.txt   # passes
ssh-keygen -Y verify -f allowed_signers -I dotbabel-evidence -n git -s msg.sig < msg.txt                    # fails
```

The run used the principal and the signers line above. This record does not keep its exact shell lines for the save and the message steps, so those two steps are equivalent commands, not a transcript.
