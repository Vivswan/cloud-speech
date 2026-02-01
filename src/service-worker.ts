import "./helpers/text-helpers";
import { bootstrap } from "./background/bootstrap";
import { registerListeners } from "./background/listeners";

// Bootstrap and initialize
bootstrap();

// Register all event listeners
registerListeners();

// Export handlers for backward compatibility
export { handlers } from "./background/handlers";
