import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DESKTOP_NOTIFICATION_REQUEST_EVENT = "notify:request";

export interface DesktopNotificationRequest {
  title: string;
  body: string;
}

export function requestDesktopNotification(
  pi: ExtensionAPI,
  request: DesktopNotificationRequest,
): void {
  pi.events.emit(DESKTOP_NOTIFICATION_REQUEST_EVENT, request);
}
