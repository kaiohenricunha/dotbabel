# Secrets

## Key Concepts

- **`pulumi config set --secret`**: encrypts a config value using the stack's secrets provider; value is stored encrypted in `Pulumi.<stack>.yaml`
- **`pulumi.Config.requireSecret`**: reads a config value and wraps it in a `pulumi.Output<string>` that Pulumi treats as sensitive throughout the resource graph
- **Secret outputs**: any `Output<T>` derived from a secret input is automatically marked sensitive and will not appear in plaintext in `pulumi stack output`
- **Secrets provider**: the encryption backend — default is Pulumi Cloud (managed keys); alternatives include AWS KMS, Azure Key Vault, GCP KMS, and a passphrase
- **Pulumi ESC (Environments, Secrets, Configs)**: a secrets management layer that centralizes configuration and short-lived credentials; stacks pull from ESC environments at runtime

## Common Patterns

**Storing a secret in stack config**:

```bash
pulumi config set --secret db_password "hunter2"
```

**Reading a secret in TypeScript**:

```typescript
const config = new pulumi.Config();
const dbPassword = config.requireSecret("db_password");

// dbPassword is Output<string> — always encrypted in state
const instance = new aws.rds.Instance("db", {
  password: dbPassword,
});
```

**ESC integration**:

```bash
# Link an ESC environment to a stack
pulumi config env add myorg/myproject/production

# The stack pulls AWS credentials and config from ESC at runtime
```

**Self-managed KMS secrets provider**:

```bash
pulumi stack init prod --secrets-provider="awskms://alias/pulumi-secrets?region=us-east-1"
```

**Never export secrets as plaintext outputs**: if a stack needs to pass a secret to another stack, use a `StackReference` with a secret-marked output — not a plaintext string output.

## Checklist

- [ ] All passwords, API keys, and tokens stored with `pulumi config set --secret`
- [ ] `config.requireSecret` used for all secret reads (not `config.require`)
- [ ] No secret values in plaintext `pulumi stack output` (verify with `--show-secrets`)
- [ ] Secrets provider configured for team usage (not default passphrase in CI)
- [ ] ESC used for short-lived cloud credentials instead of long-lived keys in config
- [ ] `Pulumi.<stack>.yaml` reviewed — no unencrypted secrets accidentally committed

## Gotchas

**Using `config.require` instead of `config.requireSecret` leaks the value into plaintext state.** Once a secret is read without the `Secret` variant, Pulumi does not know the value is sensitive and may include it in log output, stack output, or state files in plaintext. If this happens, rotate the credential immediately and re-set it with `--secret`.
