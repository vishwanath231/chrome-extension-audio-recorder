document.getElementById("requestBtn").addEventListener("click", async () => {
  const successMsg = document.getElementById("successMsg");
  const errorMsg = document.getElementById("errorMsg");
  const btn = document.getElementById("requestBtn");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Permission granted!
    successMsg.style.display = "block";
    errorMsg.style.display = "none";
    btn.style.display = "none";

    // Stop the stream immediately, we just needed the permission
    stream.getTracks().forEach((track) => track.stop());

    // Close the tab after a short delay
    setTimeout(() => {
      window.close();
    }, 2000);
  } catch (err) {
    console.error("Error requesting permission:", err);
    errorMsg.textContent =
      "Error: " + err.message + ". Please ensure you allow microphone access.";
    errorMsg.style.display = "block";
    successMsg.style.display = "none";
  }
});
