export default {
  matrix: [
    { name: "lint", mode: "hard", command: "npm run lint" },
    { name: "test", mode: "hard", command: "npm test" },
    { name: "dogfood", mode: "hard", command: "npm run dogfood" },
    { name: "build-plugin --check", mode: "hard", command: "npm run build-plugin -- --check" },
  ],
  pushAfterAttest: true,
};
