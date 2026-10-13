/** jsdom has dialog elements but does not implement their native modal methods. */
export function installDialogStub() {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}
