import type { ActionDefinition } from './types.js';
import type { ActionRegistry } from './dispatch.js';
import { agentDemoAction } from './agent-demo.js';
import { agentTurnAction } from './agent-turn.js';
import { approveDraftAction } from './approve-draft.js';
import { cancelAgentTurnAction } from './cancel-agent-turn.js';
import { cancelOutboxAction } from './cancel-outbox.js';
import { clearAgentPanelAction } from './clear-agent-panel.js';
import { confirmProposalAction } from './confirm-proposal.js';
import { deepenHistoryAction } from './deepen-history.js';
import { discardVoiceSuggestionAction } from './discard-voice-suggestion.js';
import { dismissCancellationNoticeAction } from './dismiss-cancellation-notice.js';
import { editDraftAction } from './edit-draft.js';
import { generateDraftAction } from './generate-draft.js';
import { getDraftAction } from './get-draft.js';
import { getMessagesAction } from './get-messages.js';
import { installProviderAction } from './install-provider.js';
import { listChatsAction } from './list-chats.js';
import { verifyHarnessIsolationAction } from './verify-harness-isolation.js';
import { loadMediaAction } from './load-media.js';
import { markReadAction } from './mark-read.js';
import { openChatAction } from './open-chat.js';
import { promoteVoiceSuggestionAction } from './promote-voice-suggestion.js';
import { proposeReactionAction } from './propose-reaction.js';
import { proposeSendAction } from './propose-send.js';
import { reactAction } from './react.js';
import { refineDraftAction } from './refine-draft.js';
import { rejectProposalAction } from './reject-proposal.js';
import { refreshVoiceAction } from './refresh-voice.js';
import { regeneratePairingAction } from './regenerate-pairing.js';
import { saveVoiceAction } from './save-voice.js';
import { sendAction } from './send.js';
import { setSendModeAction } from './set-send-mode.js';
import { setSettingAction } from './set-setting.js';
import { skipDraftAction } from './skip-draft.js';
import { suggestVoiceNoteAction } from './suggest-voice-note.js';

const actions: ActionDefinition<unknown>[] = [
	agentDemoAction as ActionDefinition<unknown>,
	agentTurnAction as ActionDefinition<unknown>,
	approveDraftAction as ActionDefinition<unknown>,
	cancelAgentTurnAction as ActionDefinition<unknown>,
	cancelOutboxAction as ActionDefinition<unknown>,
	clearAgentPanelAction as ActionDefinition<unknown>,
	confirmProposalAction as ActionDefinition<unknown>,
	deepenHistoryAction as ActionDefinition<unknown>,
	discardVoiceSuggestionAction as ActionDefinition<unknown>,
	dismissCancellationNoticeAction as ActionDefinition<unknown>,
	editDraftAction as ActionDefinition<unknown>,
	generateDraftAction as ActionDefinition<unknown>,
	getDraftAction as ActionDefinition<unknown>,
	getMessagesAction as ActionDefinition<unknown>,
	installProviderAction as ActionDefinition<unknown>,
	verifyHarnessIsolationAction as ActionDefinition<unknown>,
	listChatsAction as ActionDefinition<unknown>,
	loadMediaAction as ActionDefinition<unknown>,
	markReadAction as ActionDefinition<unknown>,
	openChatAction as ActionDefinition<unknown>,
	promoteVoiceSuggestionAction as ActionDefinition<unknown>,
	proposeReactionAction as ActionDefinition<unknown>,
	proposeSendAction as ActionDefinition<unknown>,
	reactAction as ActionDefinition<unknown>,
	refineDraftAction as ActionDefinition<unknown>,
	rejectProposalAction as ActionDefinition<unknown>,
	refreshVoiceAction as ActionDefinition<unknown>,
	regeneratePairingAction as ActionDefinition<unknown>,
	saveVoiceAction as ActionDefinition<unknown>,
	sendAction as ActionDefinition<unknown>,
	setSendModeAction as ActionDefinition<unknown>,
	setSettingAction as ActionDefinition<unknown>,
	skipDraftAction as ActionDefinition<unknown>,
	suggestVoiceNoteAction as ActionDefinition<unknown>
];

export function createActionRegistry(): ActionRegistry {
	const map = new Map<string, ActionDefinition<unknown>>();
	for (const action of actions) {
		if (map.has(action.name)) {
			throw new Error(`Duplicate action name: ${action.name}`);
		}
		map.set(action.name, action);
	}
	return map;
}

/** Default process-wide registry — routes and tests share the same declarations. */
export const actionRegistry = createActionRegistry();

export {
	dispatch,
	listActionsForCaller,
	type ActionRegistry
} from './dispatch.js';
export type {
	ActionCaller,
	ActionContext,
	ActionDefinition,
	ActionResult
} from './types.js';
export { actionError, actionJson } from './types.js';
