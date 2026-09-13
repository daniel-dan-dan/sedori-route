// A read-only entry point: deliberately does not load inventory API/storage code.
const Router = {
  navigate(name) {
    if (name === 'home') window.location.assign('index.html#home');
  }
};
document.addEventListener('DOMContentLoaded', () => {
  BrandGuide.render(document.getElementById('app')).catch(() => {
    document.getElementById('app').textContent = '図鑑画面を開けませんでした。もう一度開き直してください。';
  });
});
