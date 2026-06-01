import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { resetAdminPassword } from '../server/services/adminAuth.js'

async function readPipedAnswers() {
  let raw = ''
  for await (const chunk of input) raw += chunk
  const lines = raw.split(/\r?\n/)
  return {
    username: lines[0]?.trim() || 'admin',
    displayName: lines[1]?.trim() || 'Admin',
    password: lines[2] || '',
    confirm: lines[3] || '',
  }
}

async function askTerminalAnswers() {
  const rl = createInterface({ input, output })
  try {
    return {
      username: (await rl.question('Admin username [admin]: ')).trim() || 'admin',
      displayName: (await rl.question('Display name [Admin]: ')).trim() || 'Admin',
      password: await rl.question('New password: '),
      confirm: await rl.question('Confirm password: '),
    }
  } finally {
    rl.close()
  }
}

try {
  const answers = input.isTTY ? await askTerminalAnswers() : await readPipedAnswers()

  if (answers.password !== answers.confirm) {
    throw new Error('Passwords do not match')
  }

  const admin = await resetAdminPassword({
    username: answers.username,
    displayName: answers.displayName,
    password: answers.password,
  })

  output.write(`Admin password reset for ${admin.username}.\n`)
} catch (err) {
  output.write(`Reset failed: ${err.message}\n`)
  process.exitCode = 1
}
