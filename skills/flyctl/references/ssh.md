# `/flyctl ssh`

Open an interactive shell or file-transfer session inside a Fly Machine.

## Subverbs

| Form              | Command                                                 | Use case                        |
| ----------------- | ------------------------------------------------------- | ------------------------------- |
| Interactive shell | `flyctl ssh console -a $APP`                            | `printenv`, ad-hoc debugging    |
| Pin to a machine  | `flyctl ssh console -a $APP -s <id>`                    | When one machine is misbehaving |
| One-shot command  | `flyctl ssh console -a $APP -C "printenv DATABASE_URL"` | Scriptable inspection           |
| File transfer     | `flyctl ssh sftp shell -a $APP`                         | `get` / `put` of small files    |
| Issue SSH cert    | `flyctl ssh issue -a $APP`                              | When auth handshake fails       |

## SSH cert refresh

`flyctl` issues short-lived SSH certs automatically. If `flyctl ssh console`
fails with an authentication error, refresh:

```bash
flyctl ssh issue -a $APP
flyctl ssh console -a $APP
```

## Safety

- SSH gives you a shell on the running machine. Be careful with commands that
  modify state (DB writes, file overwrites, signal sending). Prefer read-only
  inspection (`printenv`, `ls`, `cat`).
- Never run interactive commands that don't terminate (`top`, `htop`) inside a
  one-shot `-C` call — use `flyctl ssh console` interactively instead.
- Don't `cat` secrets to the screen. If you need a value, redirect to a local
  file with `flyctl ssh sftp` or set up a project-side audit log.

## When the machine has no shell

Slim runtime images (distroless, scratch) have no `/bin/sh`. `flyctl ssh
console` will fail with "exec format error" or similar. Workarounds:

- Add a debug shim to the Dockerfile (`COPY --from=busybox /bin/busybox /bin/sh`)
- Use `flyctl logs` for runtime inspection instead
- Open a temporary shell-bearing image with `flyctl deploy --image alpine`
  (extreme — only in a non-prod app)

## Confirmation rail

SSH is interactive but read-shell from the skill's perspective; commands
executed inside the SSH session are operator-driven. The skill does not gate
`flyctl ssh console`. Inside the session, the operator is responsible for any
mutations they perform.
