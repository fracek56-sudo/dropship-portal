function guard(requiredRole) {
  const token = localStorage.getItem("token");
  const role = localStorage.getItem("role");
  if (!token || role !== requiredRole) {
    window.location.href = "/login.html";
  }
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("role");
  localStorage.removeItem("email"); // ✅ ważne
  window.location.href = "/login.html";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}
