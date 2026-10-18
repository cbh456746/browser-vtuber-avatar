import { frameUrl } from "./pose.js";
import { stageRenderer } from "./mascot.js";
const container = document.getElementById("output-stage"),
  render = stageRenderer(container);
window.avatarStudio.subscribe((state) => {
  document.body.dataset.background = state.settings.background;
  render({ ...state, frameUrl: state.avatar.id ? frameUrl(state) : null });
});
