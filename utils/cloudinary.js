const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const subirImagen = (file) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "productos",
        quality: "auto:good",
        fetch_format: "auto",
        transformation: [
          { width: 900, height: 900, crop: "limit" }
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );

    const bufferStream = Readable.from(file.buffer);
    bufferStream.pipe(stream);
  });
};

const eliminarImagen = async (public_id) => {
  return await cloudinary.uploader.destroy(public_id);
};

module.exports = { subirImagen, eliminarImagen };
