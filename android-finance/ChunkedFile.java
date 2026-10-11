package kz.luxar.finance;

import java.util.Base64;
import java.util.UUID;

/** Bounded, ordered transport; no file picker opens until all bytes arrive. */
final class ChunkedFile {
    static final String XLSX="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    static final int MAX_LENGTH=16000000, CHUNK_LENGTH=4000;
    final String id=UUID.randomUUID().toString(), name, mime;
    private final int length;
    private int next;
    private final StringBuilder data;
    private long touched=System.currentTimeMillis();

    ChunkedFile(String name,String mime,int length){
        if(!XLSX.equals(mime)&&!"text/csv".equals(mime)&&!"application/json".equals(mime))throw new IllegalArgumentException("Неверный формат файла");
        if(length<4||length>MAX_LENGTH||length%4!=0)throw new IllegalArgumentException("Файл пустой или слишком большой");
        this.name=name;this.mime=mime;this.length=length;data=new StringBuilder(Math.min(length,64000));
    }
    private void check(String token){
        if(!id.equals(token)||System.currentTimeMillis()-touched>60000)throw new IllegalArgumentException("Передача файла прервана. Повтори скачивание");
        touched=System.currentTimeMillis();
    }
    void append(String token,int index,String chunk){
        check(token);
        if(index!=next||chunk.isEmpty()||chunk.length()>CHUNK_LENGTH||chunk.length()%4!=0||data.length()+chunk.length()>length||!chunk.matches("[A-Za-z0-9+/]*={0,2}"))throw new IllegalArgumentException("Не удалось передать файл. Повтори скачивание");
        if(chunk.indexOf('=')>=0&&data.length()+chunk.length()!=length)throw new IllegalArgumentException("Не удалось передать файл. Повтори скачивание");
        data.append(chunk);next++;
    }
    byte[] finish(String token){
        check(token);
        if(data.length()!=length)throw new IllegalArgumentException("Файл передан не полностью. Повтори скачивание");
        byte[] bytes;
        try{bytes=Base64.getDecoder().decode(data.toString());}catch(IllegalArgumentException e){throw new IllegalArgumentException("Неверные данные файла");}
        if(XLSX.equals(mime)&&(bytes.length<4||bytes[0]!=80||bytes[1]!=75||bytes[2]!=3||bytes[3]!=4))throw new IllegalArgumentException("Неверный Excel-файл");
        return bytes;
    }
}
