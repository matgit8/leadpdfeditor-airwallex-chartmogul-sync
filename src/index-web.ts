import { startServer } from "./http/server";
import dotenv from "dotenv";

dotenv.config();

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

