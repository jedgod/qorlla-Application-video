// Guest welcome uses ordinary links; authorization must be enforced on the server.
// Keep language options limited to translations actually implemented.
document.querySelectorAll('a[href^="/guest/"]').forEach(link => {
  link.addEventListener('click', () => {
    // No authentication tokens or guest permissions are issued here.
  });
});
