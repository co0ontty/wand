// Deterministic, credential-free CLI for the StructuredExecHost contract suite.
// This is not a recording of a real provider and never prints its environment.
const mode = process.argv[2];

switch (mode) {
  case "stdio": {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      // Give the caller time to make a duplicate spawn while the run is live.
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify({ input, args: process.argv.slice(3) })}\n`);
        process.stderr.write("诊断🙂\n");
      }, 250);
    });
    break;
  }
  case "utf8": {
    const stdout = Buffer.from('{"text":"你好🙂"}\n');
    const stderr = Buffer.from("诊断🙂\n");
    process.stdout.write(stdout.subarray(0, 10)); // mid 你
    process.stderr.write(stderr.subarray(0, 4)); // mid 断
    setTimeout(() => {
      process.stdout.write(stdout.subarray(10));
      process.stderr.write(stderr.subarray(4));
    }, 30);
    break;
  }
  case "fast":
    process.stdout.write("fast\n");
    process.stderr.write("failed\n");
    process.exitCode = 7;
    break;
  case "empty":
    break;
  case "reconnect":
    process.stdout.write("one\n");
    setTimeout(() => {
      process.stdout.write("two\n");
      process.stderr.write("diagnostic\n");
    }, 350);
    setTimeout(() => process.stdout.write("three\n"), 1200);
    break;
  case "cancel":
    process.stdout.write("ready\n");
    setInterval(() => {}, 1000);
    break;
  default:
    throw new Error(`Unknown contract scenario: ${mode}`);
}
