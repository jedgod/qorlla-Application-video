// Explicitly deny all operations until actual Meet adapters are installed.
export async function authenticateMeetRequest(){return null;}
export async function authenticateMeetWebSocket(){return null;}
export async function authorizeOccurrence(){return false;}
export async function authorizeParticipant(){return false;}
export async function prepareBreakoutMove(){return null;}
export async function commitBreakoutMove(){throw new Error('unconfigured');}
export async function cancelBreakoutMove(){}
export async function hasTranscriptionConsent(){return false;}
export async function startPrivateAudioCapture(){return null;}
