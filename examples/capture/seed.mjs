const response = await fetch(`${process.env.CAPTURE_API_URL || 'http://localhost:4301'}/signup`, { method: 'POST' });
if (!response.ok) throw new Error(`account preparation failed: ${response.status}`);
const account = await response.json();
if (typeof account.username !== 'string' || typeof account.password !== 'string') throw new Error('invalid account response');
process.stdout.write(JSON.stringify(account) + '\n');
