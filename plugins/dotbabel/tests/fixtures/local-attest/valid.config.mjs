export default {
  matrix: [
    { name: "deps", mode: "hard", command: "true" },
    { name: "lint", mode: "hard", command: "true" },
    { name: "test", mode: "hard", command: "true" },
    { name: "knip", mode: "advisory", command: "true" },
  ],
};
