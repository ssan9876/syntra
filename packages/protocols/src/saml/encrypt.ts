import xmlenc from 'xml-encryption';

/**
 * Wraps a signed assertion in an EncryptedAssertion.
 *
 * AES-256-GCM for the content and RSA-OAEP for the key. Neither choice is
 * negotiable and neither is configurable: CBC without an authenticated mode
 * is the shape that produced real padding-oracle attacks against SAML
 * decryption, and `rsa-1_5` is Bleichenbacher. A tenant that needs a legacy
 * SP to work needs a different SP.
 *
 * The assertion is signed *before* it is encrypted, so the SP verifies the
 * signature on what it decrypts. Encrypting first and signing the ciphertext
 * would authenticate the envelope and not the claim.
 *
 * `xml-encryption` is callback-style; this is the promise wrapper. It runs
 * outside every transaction — it is RSA work, and Global Constraint 1 applies.
 */
export async function encryptAssertion(
  signedAssertion: string,
  certificatePem: string,
): Promise<string> {
  const encryptedData = await new Promise<string>((resolve, reject) => {
    xmlenc.encrypt(
      signedAssertion,
      {
        rsa_pub: certificatePem,
        pem: certificatePem,
        encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: true,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });

  return `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${encryptedData}</saml:EncryptedAssertion>`;
}
