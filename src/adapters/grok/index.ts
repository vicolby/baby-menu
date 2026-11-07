import { runAdapter } from "../shared/acp-agent.js";
import { GrokDriver } from "./driver.js";

// Entry point: acpx spawns `node <this> ...` and speaks ACP over stdio.
runAdapter(new GrokDriver(), "grok-adapter");
