import { hash } from '@node-rs/argon2';

// hash-password: reads the password on stdin and prints base64(argon2 hash) for .env.
// Imports nothing that opens the database, so it runs in a throwaway container.
if (process.argv[2] === 'hash-password') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input) {
    console.error('No password given');
    process.exit(1);
  }
  console.log(Buffer.from(await hash(input)).toString('base64'));
} else {
  console.error('Usage: cli.js hash-password');
  process.exit(1);
}
