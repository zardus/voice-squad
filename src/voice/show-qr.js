const qr = require("qrcode-terminal");
const url = process.argv[2];
if (!url) {
  console.error("Usage: show-qr.js <url>");
  process.exit(1);
}
console.log("");
console.log("  Scan to open Squad Voice:");
console.log("");
qr.generate(url, { small: true }, (code) => {
  // Indent each line for nicer display
  console.log(code.split("\n").map((l) => "  " + l).join("\n"));
});
console.log("");
console.log("  " + url);
console.log("");
