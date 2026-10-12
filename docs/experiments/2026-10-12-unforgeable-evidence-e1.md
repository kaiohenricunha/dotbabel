# Experiment: Windows Hello security key from WSL (unforgeable-evidence E-1) — 2026-10-12

The unforgeable-evidence spec does not start enforcement until one key custody tier works on the maintainer's WSL host (`docs/specs/unforgeable-evidence/spec/6-implementation-plan.md`, PR-3 entry condition, OPS-4). Experiment E-1 asks if Windows OpenSSH (`ssh-keygen.exe`), started from WSL, can hold an OpenSSH security-key (`sk-`) key in Windows Hello. This record has the unattended probes, the three attended attempts, and the WebAuthN log lines.

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

The attended note for attempt 1 records a timeout at 180 s. In the log, each attempt ends with `0x800704C7` "The operation was canceled by the user" (22:23:12, 22:25:26, and 22:33:19).

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
- **Tiers left on this host, all untested:** a USB FIDO2 key through `ssh-keygen.exe` (spec A-5, with the user-presence flag), the Bitwarden desktop SSH agent (spec A-6, with no user-presence flag), and the separate-user signer (spec A-4, weak while interop is on).
- **Owner decision, 2026-10-12:** the Bitwarden desktop SSH agent. The spec records it as KD-13 and §8 A-6, with its measured facts pending.

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
