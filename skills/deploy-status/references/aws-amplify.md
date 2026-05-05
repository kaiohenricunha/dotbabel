# AWS Amplify Deploy Status

AWS Amplify is a documented stub in this version. A project may list an
`aws-amplify` target in `.claude/deploy-targets.json`, but the helper will fail
closed with exit `2` until a real consumer defines the exact status and rollback
contract.

Expected future config shape:

```json
{
  "kind": "aws-amplify",
  "appId": "d123...",
  "branch": "main",
  "region": "us-east-1"
}
```

Do not add Amplify API calls without tests that prove SHA extraction, production
branch selection, and rollback behavior against representative CLI JSON.
