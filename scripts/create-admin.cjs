// scripts/create-admin.cjs  — CommonJS, run with: node scripts/create-admin.cjs
require("dotenv").config();
const { neonConfig, Pool } = require("@neondatabase/serverless");
const ws = require("ws");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const email = "admin@instructionalgraphics.com";
const password = "Admin@123!";
const name = "Admin User";

async function main() {
  const check = await pool.query('SELECT id FROM "User" WHERE email = $1', [
    email,
  ]);
  if (check.rows.length > 0) {
    console.log(`Admin already exists: ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  const now = new Date().toISOString();

  await pool.query(
    `INSERT INTO "User" (id, email, "passwordHash", name, role, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 'ADMIN', $5, $5)`,
    [id, email, passwordHash, name, now],
  );

  console.log("✅ Admin user created:");
  console.log(`   Email: ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   ID: ${id}`);
}
//=
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
