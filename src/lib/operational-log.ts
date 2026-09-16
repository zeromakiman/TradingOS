import "server-only";
// Fixed event names and status codes only. Never serialize an Error or request.
export function operationalFailure(event:"request_failed"|"auth_unavailable"|"storage_upload_failed"|"storage_registration_failed"|"storage_cleanup_failed"|"database_write_failed"|"data_read_failed",status=500){
 console.error(JSON.stringify({event,status}));
}
