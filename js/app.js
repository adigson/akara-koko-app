let cart = [];
let total = 0;
let deliveryFee = 0;
let language = "en";
let adminToken = "";
const translations = {
  en: { tagline: "Fresh • Hot • Bottled or Servable", admin: "Admin", menu: "Menu", add: "Add", cart: "Your Cart", location: "Delivery location", time: "Delivery date and time", payment: "Payment", cash: "WhatsApp / Cash on delivery", whatsapp: "Place order via WhatsApp", receipt: "Download receipt PDF", orders: "Orders", close: "Close" },
  yo: { tagline: "Tútù • Gbóná • Nínú igo tàbí ago", admin: "Alábòójútó", menu: "Ojúẹẹran", add: "Fi kún", cart: "Aṣayan rẹ", location: "Ibi fífiránṣẹ́", time: "Ọjọ́ àti àsìkò fífiránṣẹ́", payment: "Ìsanwó", cash: "WhatsApp / Sanwo lẹ́yìn fífiránṣẹ́", whatsapp: "Fi àṣẹ ranṣẹ́ nípasẹ̀ WhatsApp", receipt: "Ṣègbàwọ́lẹ̀ ìwé ìsanwó PDF", orders: "Àwọn àṣẹ", close: "Tì" }
};
function addToCart(name, price) {
  const item = cart.find(entry => entry.name === name && entry.price === price);
  if (item) item.quantity += 1;
  else cart.push({ name, price, quantity: 1 });
  renderCart();
}
function changeQuantity(index, amount) {
  cart[index].quantity += amount;
  if (cart[index].quantity <= 0) cart.splice(index, 1);
  renderCart();
}
function removeItem(index) { cart.splice(index, 1); renderCart(); }
function renderCart() {
  const cartItems = document.getElementById("cartItems"); cartItems.innerHTML = "";
  cart.forEach((item, index) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="cart-item-name"><strong>${item.name}</strong><small>₦${item.price} each</small></div><div class="quantity-control"><button onclick="changeQuantity(${index}, -1)" aria-label="Decrease ${item.name}">−</button><span>${item.quantity}</span><button onclick="changeQuantity(${index}, 1)" aria-label="Increase ${item.name}">+</button></div><strong>₦${item.price * item.quantity}</strong><button class="remove" onclick="removeItem(${index})" aria-label="Remove ${item.name}">✕</button>`;
    cartItems.appendChild(li);
  });
  updateOrderTotals();
}
function updateOrderTotals() {
  total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  document.getElementById("total").textContent = `Food Total: ₦${total}`;
  document.getElementById("deliveryFee").textContent = deliveryFee;
  document.getElementById("grandTotal").textContent = total + deliveryFee;
}
function getOrderDetails() { return { location: document.getElementById("deliveryLocation").value, deliveryTime: document.getElementById("deliveryTime")?.value || "", payment: document.querySelector('input[name="payment"]:checked')?.value || "WhatsApp / Cash" }; }
function validateOrder() {
  const details = getOrderDetails();
  if (!cart.length) { alert("Your cart is empty!"); return false; }
  if (!details.location) { alert("Please enter a delivery location."); document.getElementById("deliveryLocation").focus(); return false; }
  if (!details.deliveryTime) { alert("Please choose a delivery time."); document.getElementById("deliveryTime").focus(); return false; }
  return true;
}
async function saveOrder() {
  const details = getOrderDetails();
  const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: cart, total, deliveryFee, grandTotal: total + deliveryFee, location: details.location, deliveryTime: details.deliveryTime, customerName: document.getElementById("customerName").value.trim(), phone: document.getElementById("customerPhone").value.trim(), address: document.getElementById("customerAddress").value.trim(), payment: details.payment }) });
  if (!response.ok) throw new Error("Could not save order");
  return response.json();
}
function updateDeliveryFee() {
  const location = document.getElementById("deliveryLocation");
  deliveryFee = Number(location.value) || 0;
  updateOrderTotals();
}

async function checkout() {
  if (cart.length === 0) {
    alert("Your cart is empty!");
    return;
  }

  const name = document.getElementById("customerName").value.trim();
  const phone = document.getElementById("customerPhone").value.trim();
  const address = document.getElementById("customerAddress").value.trim();
  const time = document.getElementById("deliveryTime").value;
  const location = document.getElementById("deliveryLocation");

  if (!name || !phone || !address || !time || !location.value) {
    alert("Please complete all delivery details.");
    return;
  }
  if (!document.getElementById("acceptDeliveryPolicy").checked) {
    alert("Please read and accept the Delivery & Refund Policy before placing your order.");
    return;
  }

  const selectedPayment = document.querySelector('input[name="payment"]:checked').value;
  if (selectedPayment !== "WhatsApp / Cash") {
    const key = document.getElementById("confirmationKey").value.trim().toUpperCase();
    const keyResponse = await fetch("/api/confirmations/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
    const confirmation = await keyResponse.json();
    if (!keyResponse.ok || !confirmation.valid) {
      alert("Payment refused. Enter the delivery confirmation key from the admin before making online payment.");
      return;
    }
  }

  let message = `Hello, I want to order:%0A%0A`;
  cart.forEach(item => {
    message += `- ${item.quantity} × ${item.name} — ₦${item.price * item.quantity}%0A`;
  });

  message += `%0A*Food Total:* ₦${total}`;
  message += `%0A*Delivery Fee:* ₦${deliveryFee}`;
  message += `%0A*Grand Total:* ₦${total + deliveryFee}%0A%0A`;
  message += `*Customer Name:* ${name}%0A`;
  message += `*Phone:* ${phone}%0A`;
  message += `*Address:* ${address}%0A`;
  message += `*Delivery Area:* ${location.options[location.selectedIndex].text}%0A`;
  message += `*Delivery Time:* ${time}`;

  try { await saveOrder(); } catch { alert("We could not submit the order. Please try again."); return; }
  const phoneNumber = "2348063198660";
  const encodedMessage = encodeURIComponent(message.replaceAll("%0A", "\n"));
  window.open(`https://wa.me/${phoneNumber}?text=${encodedMessage}`, "_blank", "noopener,noreferrer");
}
async function downloadReceipt() {
  if (!validateOrder()) return; const details = getOrderDetails(); let order; try { order = await saveOrder(); } catch { alert("Could not save the receipt order. Please try again."); return; }
  const receiptWindow = window.open("", "_blank"); if (!receiptWindow) { alert("Please allow pop-ups to download the receipt."); return; }
  const items = cart.map(item => `<li>${item.quantity} × ${item.name} — ₦${item.price * item.quantity}</li>`).join("");
  receiptWindow.document.write(`<!doctype html><html><head><title>Receipt ${order.id}</title><style>body{font-family:Arial;max-width:600px;margin:30px auto;color:#333}h1{color:#8b0000}.total{font-size:1.2em;font-weight:bold}button{padding:.7rem 1rem}</style></head><body><h1>🥣 Akara & Koko</h1><p>Order #${order.id}</p><ul>${items}</ul><p>Food Total: ₦${total}</p><p>Delivery Fee: ₦${deliveryFee}</p><p class="total">Grand Total: ₦${total + deliveryFee}</p><p><b>Delivery:</b><br>${details.location}<br>${details.deliveryTime}</p><p><b>Payment:</b> ${details.payment}</p><button onclick="print();close()">Save as PDF / Print</button></body></html>`); receiptWindow.document.close();
}
function toggleLanguage() { language = language === "en" ? "yo" : "en"; document.querySelectorAll("[data-i18n]").forEach(el => el.textContent = translations[language][el.dataset.i18n]); document.getElementById("languageToggle").textContent = language === "en" ? "Yorùbá" : "English"; }
async function showAdmin() { const password = prompt("Enter admin password:"); if (password === null) return; const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }); if (!response.ok) { alert("Incorrect password."); return; } ({ token: adminToken } = await response.json()); await renderOrders(); document.getElementById("adminPanel").hidden = false; document.getElementById("adminPanel").scrollIntoView({ behavior: "smooth" }); }
function hideAdmin() { document.getElementById("adminPanel").hidden = true; }
async function renderOrders() { if (!adminToken) return; const response = await fetch("/api/admin/orders", { headers: { Authorization: "Bearer " + adminToken } }); if (!response.ok) return; const orders = await response.json(); const container = document.getElementById("orders"); container.innerHTML = orders.length ? orders.map(order => `<article class="order"><div><b>#${order.id}</b> <span>${order.status}</span></div><p>${order.items.map(item => `${item.quantity || 1} × ${item.name}`).join(", ")}</p><p><b>₦${order.total}</b> · ${order.location || "No area"} · ${order.deliveryTime}</p>${order.confirmationKey ? `<p><b>Confirmation key:</b> ${order.confirmationKey}</p>` : ""}<div class="order-actions"><button onclick="approveDelivery(${order.id})">Approve delivery</button><button class="decline" onclick="declineDelivery(${order.id})">Decline delivery</button><button onclick="completeDelivery(${order.id})">Complete delivery</button></div></article>`).join("") : "<p>No orders yet.</p>"; }
async function setDeliveryDecision(id, decision) { if (!adminToken) return; const response = await fetch(`/api/admin/orders/${id}/${decision}`, { method: "POST", headers: { Authorization: "Bearer " + adminToken } }); if (!response.ok) return alert("Could not update the order."); await response.json(); await renderOrders(); if (decision === "approve") alert("Delivery confirmed."); else if (decision === "complete") alert("Delivery marked as completed."); else alert("Delivery declined. Online payment will not be accepted for this order."); }
function approveDelivery(id) { return setDeliveryDecision(id, "approve"); }
function declineDelivery(id) { return setDeliveryDecision(id, "decline"); }
function completeDelivery(id) { return setDeliveryDecision(id, "complete"); }
function openDeliveryPolicy(event) {
  if (event) event.preventDefault();
  document.getElementById("deliveryPolicyDialog")?.showModal();
}
function closeDeliveryPolicy() {
  document.getElementById("deliveryPolicyDialog")?.close();
}
function acceptDeliveryPolicy() {
  document.getElementById("acceptDeliveryPolicy").checked = true;
  closeDeliveryPolicy();
}
window.addEventListener("DOMContentLoaded", () => {
  updateOrderTotals();
  document.getElementById("policyLink")?.addEventListener("click", openDeliveryPolicy);
});
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js"));
