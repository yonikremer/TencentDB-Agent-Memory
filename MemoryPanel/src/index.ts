// Unified entry point: directly start the stateless panel (Link A).
// Legacy Link B has been removed and no longer requires the PANEL_MODE branching.
import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { main } from './panel/index.js';
main();
