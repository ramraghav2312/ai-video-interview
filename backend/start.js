const { spawn } = require('child_process');

const server = spawn('node', ['server.js'], { stdio: 'inherit' });
const worker = spawn('node', ['worker.js'], { stdio: 'inherit' });

server.on('exit', (code) => {
  console.error(`server.js exited with code ${code}`);
  process.exit(code);
});

worker.on('exit', (code) => {
  console.error(`worker.js exited with code ${code}`);
  process.exit(code);
});