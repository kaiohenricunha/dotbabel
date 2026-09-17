# AWS Amplify Rollback

AWS Amplify rollback is a documented stub in this version. The helper fails
closed for `aws-amplify` targets until a real consumer defines:

- How to identify the production branch/job.
- How to extract the deployed git SHA.
- Which Amplify CLI or AWS CLI operation is the native rollback primitive.
- How to verify rollback completion.

Do not emulate rollback by rebuilding an arbitrary commit. This skill should use
the provider's native rollback or redeploy primitive once it is specified.
