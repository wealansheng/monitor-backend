'use strict';

const express = require('express');

function requestDataMiddleware(maxBodySize) {
  return express.raw({
    inflate: true,
    limit: maxBodySize,
    type: () => true,
  });
}

module.exports = { requestDataMiddleware };
