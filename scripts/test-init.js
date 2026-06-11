const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const cp = require('child_process');
const fs = require('fs');

const portPath = process.argv[2] || process.env.NODEMCU_VSCODE_SERIAL_PORT;
if (!portPath) {
  throw new Error("Usage: node scripts/test-init.js <serial-port> or set NODEMCU_VSCODE_SERIAL_PORT");
}

try {
  // 1. Create init.lua
  fs.writeFileSync('init.lua', `print("HELLO USER, init.lua is running!")\n`);

  // 2. Upload init.lua
  console.log(`Uploading init.lua to ${portPath}...`);
  cp.execSync(`npx nodemcu-tool upload init.lua --port ${portPath}`, { stdio: 'inherit' });

  // 3. Listen to serial monitor
  console.log(`Listening on ${portPath}...`);
  const port = new SerialPort({ path: portPath, baudRate: 115200 });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  parser.on('data', data => {
    console.log(`[DEVICE]: ${data.trim()}`);
    if (data.includes("HELLO USER, init.lua is running!")) {
      console.log("SUCCESS! init.lua was executed.");
      setTimeout(() => process.exit(0), 1000);
    }
  });

  port.on('open', () => {
    console.log("Port opened. Resetting device...");
    port.set({ dtr: false, rts: true }, () => {
      setTimeout(() => {
        port.set({ dtr: false, rts: false });
      }, 100);
    });
  });

  // Timeout after 15 seconds
  setTimeout(() => {
    console.log("Timeout waiting for init.lua output.");
    process.exit(1);
  }, 15000);
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}
