import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './src/app.js'

const dataDir = process.env.RD_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
const port = Number(process.env.PORT) || 3000
const { server, db } = await createApp({ dataDir })
server.listen(port, () => console.log(`RD Cloude running on http://localhost:${port}`))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (db.flush(), process.exit(0)))
